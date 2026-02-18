import { lookupNutrition } from '../../nutrition-lookup/index.ts';
import { createAdminClient } from '../../_shared/supabase-client.ts';
import { createOpenAIClient } from '../../_shared/openai-client.ts';
import { normalizeFoodName } from '../../_shared/utils.ts';
import { MASTER_NUTRIENT_MAP } from '../../_shared/nutrients.ts';
// Fallback nutrition data for common ingredients (per 100g unless specified)
const NUTRITION_FALLBACKS = {};
// Modifiers to remove for loose matching
const INGREDIENT_MODIFIERS = [
  'organic',
  'fresh',
  'frozen',
  'canned',
  'dried',
  'raw',
  'cooked',
  'low sodium',
  'low-sodium',
  'reduced sodium',
  'no salt added',
  'low fat',
  'low-fat',
  'reduced fat',
  'fat free',
  'fat-free',
  'high oleic',
  'extra virgin',
  'virgin',
  'pure',
  'natural',
  'whole',
  'chopped',
  'diced',
  'sliced',
  'minced',
  'crushed',
  'boneless',
  'skinless',
  'bone-in',
  'skin-on',
  'large',
  'medium',
  'small',
  'mini',
  'ripe',
  'unripe',
  'mature',
  'unsalted',
  'salted',
  'roasted',
  'toasted',
  'plain',
  'flavored',
  'sweetened',
  'unsweetened'
];
// Track failed lookups for logging
const failedLookups = new Map();
/**
 * Find a fallback from NUTRITION_FALLBACKS using loose matching
 */ function findFallbackNutrition(searchTerm) {
  const normalized = searchTerm.toLowerCase().trim();
  // 1. Exact match
  if (NUTRITION_FALLBACKS[normalized]) {
    return NUTRITION_FALLBACKS[normalized];
  }
  // 2. Try after removing modifiers
  let simplified = normalized;
  for (const modifier of INGREDIENT_MODIFIERS) {
    simplified = simplified.replace(new RegExp(`\\b${modifier}\\b`, 'gi'), '').trim();
  }
  simplified = simplified.replace(/\s+/g, ' ').trim();
  if (simplified !== normalized && NUTRITION_FALLBACKS[simplified]) {
    console.log(`[NutritionAgent] Fallback match after removing modifiers: "${normalized}" -> "${simplified}"`);
    return NUTRITION_FALLBACKS[simplified];
  }
  // 3. Partial match - check if any fallback key is contained in search term or vice versa
  for (const [key, data] of Object.entries(NUTRITION_FALLBACKS)) {
    // Check if fallback key is contained in the search term
    if (normalized.includes(key)) {
      console.log(`[NutritionAgent] Fallback partial match: "${normalized}" contains "${key}"`);
      return data;
    }
    // Check if search term is contained in fallback key
    if (key.includes(simplified) && simplified.length >= 3) {
      console.log(`[NutritionAgent] Fallback partial match: "${key}" contains "${simplified}"`);
      return data;
    }
  }
  // 4. Try word-level matching for the core ingredient
  const words = simplified.split(' ');
  for (let i = words.length - 1; i >= 0; i--) {
    const candidate = words.slice(i).join(' ');
    if (NUTRITION_FALLBACKS[candidate]) {
      console.log(`[NutritionAgent] Fallback word match: "${normalized}" -> "${candidate}"`);
      return NUTRITION_FALLBACKS[candidate];
    }
  }
  return null;
}
/**
 * Log failed ingredient lookup for analytics
 */ async function logFailedLookup(ingredient, reason, context) {
  const count = (failedLookups.get(ingredient) || 0) + 1;
  failedLookups.set(ingredient, count);
  console.warn(`[NutritionAgent] FAILED LOOKUP: "${ingredient}" - ${reason} (attempt ${count})`);
  if (context?.supabase && context?.userId) {
    try {
      await context.supabase.from('analytics_failed_lookups').insert({
        user_id: context.userId,
        query: ingredient,
        portion: context.portion,
        failure_type: 'no_data',
        details: {
          reason,
          attempt: count
        }
      });
    } catch (err) {
      console.error('[NutritionAgent] Error logging analytics:', err);
    }
  }
}
/**
 * Check if nutrition data is valid (has non-zero calories for non-zero-calorie foods)
 */ function isValidNutrition(data, itemName) {
  if (!data) return false;
  // Most foods should have calories - only salt/spices have 0
  const zeroCalorieItems = [
    'salt',
    'water',
    'pepper',
    'spice',
    'herb',
    'tea',
    'coffee'
  ];
  const isZeroCalorieItem = zeroCalorieItems.some((z) => itemName.toLowerCase().includes(z));
  if (data.calories === 0 && !isZeroCalorieItem) {
    console.warn(`[NutritionAgent] Warning: 0 calories for "${itemName}" - may be incorrect`);
    return false;
  }
  return true;
}
export async function getScalingMultiplier(userPortion, servingSize, foodName, supabase) {
  if (!servingSize) return 1;
  // 1. Rule-based scaling for common units
  const userParsed = parseUnitAndAmount(userPortion);
  const officialParsed = parseUnitAndAmount(servingSize);
  if (userParsed && officialParsed) {
    // Exact unit match
    if (userParsed.unit === officialParsed.unit) {
      const multiplier = userParsed.amount / officialParsed.amount;
      if (!isNaN(multiplier) && multiplier > 0) {
        console.log(`[NutritionAgent] Rule-based scaling: ${userPortion} / ${servingSize} = ${multiplier}`);
        return multiplier;
      }
    }
    // Handle common weight-based scaling (g, oz, lb)
    const userGrams = convertToGrams(userParsed.amount, userParsed.unit);
    const officialGrams = convertToGrams(officialParsed.amount, officialParsed.unit);
    if (userGrams && officialGrams) {
      const multiplier = userGrams / officialGrams;
      console.log(`[NutritionAgent] Weight-based scaling: ${userGrams}g / ${officialGrams}g = ${multiplier}`);
      return multiplier;
    }
    // Cross-unit scaling (e.g., cups to ml, tbsp to tsp)
    const userVol = convertToMl(userParsed.amount, userParsed.unit);
    const officialVol = convertToMl(officialParsed.amount, officialParsed.unit);
    if (userVol && officialVol) {
      const multiplier = userVol / officialVol;
      console.log(`[NutritionAgent] Volume-based scaling: ${userVol}ml / ${officialVol}ml = ${multiplier}`);
      return multiplier;
    }
  }
  // Handle case where servingSize contains weight in parens: "1 cup (240g)" or "1 tbsp (15 ml)"
  if (userParsed && servingSize.includes('(')) {
    const parenMatch = servingSize.match(/\(([^)]+)\)/);
    if (parenMatch) {
      const parenContent = parenMatch[1];
      const parenParsed = parseUnitAndAmount(parenContent);
      if (parenParsed) {
        // Try weight scaling first
        const userGrams = convertToGrams(userParsed.amount, userParsed.unit);
        const parenGrams = convertToGrams(parenParsed.amount, parenParsed.unit);
        if (userGrams && parenGrams) {
          const multiplier = userGrams / parenGrams;
          console.log(`[NutritionAgent] Paren-weight scaling: ${userGrams}g / ${parenGrams}g = ${multiplier}`);
          return multiplier;
        }
        // Try volume scaling
        const userVol = convertToMl(userParsed.amount, userParsed.unit);
        const parenVol = convertToMl(parenParsed.amount, parenParsed.unit);
        if (userVol && parenVol) {
          const multiplier = userVol / parenVol;
          console.log(`[NutritionAgent] Paren-volume scaling: ${userVol}ml / ${parenVol}ml = ${multiplier}`);
          return multiplier;
        }
      }
    }
  }
  // 2. Check conversion cache if foodName provided
  if (foodName && supabase) {
    try {
      const normalizedFood = foodName.toLowerCase().trim();
      const { data: cached } = await supabase.from('unit_conversions').select('multiplier').eq('food_name', normalizedFood).eq('from_unit', userPortion.toLowerCase().trim()).eq('to_unit', servingSize.toLowerCase().trim()).limit(1).maybeSingle();
      if (cached) {
        console.log(`[NutritionAgent] Conversion cache hit: ${userPortion} -> ${servingSize} = ${cached.multiplier}`);
        return cached.multiplier;
      }
    } catch (err) {
      console.error('[NutritionAgent] Error checking conversion cache:', err);
    }
  }
  // 3. Fallback to LLM for ambiguous descriptions
  console.log(`[NutritionAgent] Falling back to LLM for scaling: "${userPortion}" vs "${servingSize}" for "${foodName}"`);
  const openai = createOpenAIClient();

  // Feature Fix: Context for unitless numbers
  const contextNote = /^\d+(\.\d+)?$/.test(userPortion.trim())
    ? `(Assume "${userPortion}" means "${userPortion} whole ${foodName}" or "${userPortion} serving")`
    : '';

  const prompt = `
Food Item: "${foodName}"
User portion input: "${userPortion}" ${contextNote}
Official serving size: "${servingSize}"

Based on the above, calculate the numerical multiplier to convert the nutrition data from the official serving size to the user's portion.
Return ONLY the numerical multiplier (e.g., 1.5, 0.5, 2). If unsure, return 1.
Example: "1 apple" (approx 180g) vs "100g" -> 1.8
`;
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: prompt
      }
    ],
    max_tokens: 10
  });
  const content = response.choices[0].message.content?.trim();
  // Robustly extract number from content
  const match = content?.match(/[\d\.]+/);
  const multiplier = match ? parseFloat(match[0]) : 1;
  console.log(`[NutritionAgent] LLM Scaling result: raw="${content}" parsed=${multiplier}`);
  const finalMultiplier = isNaN(multiplier) ? 1 : multiplier;
  // 4. Validate multiplier before saving / returning
  const SAFE_MIN = 0.1;
  const SAFE_MAX = 10.0;

  if (finalMultiplier < SAFE_MIN || finalMultiplier > SAFE_MAX) {
    console.warn(`[NutritionAgent] Dangerous multiplier detected: ${finalMultiplier} for "${userPortion}" -> "${servingSize}". Defaulting to 1.`);
    return 1;
  }

  // 5. Save to cache if successful
  if (foodName && supabase && finalMultiplier !== 1) {
    try {
      await supabase.from('unit_conversions').insert({
        food_name: foodName.toLowerCase().trim(),
        from_unit: userPortion.toLowerCase().trim(),
        to_unit: servingSize.toLowerCase().trim(),
        multiplier: finalMultiplier
      });
    } catch (err) {
      console.error('[NutritionAgent] Error saving to conversion cache:', err);
    }
  }
  return finalMultiplier;
}
function parseUnitAndAmount(str) {
  const cleaned = str.toLowerCase().trim();
  // Handle cases like "a cup", "an egg", "some milk"
  const wordAmounts = {
    'a': 1,
    'an': 1,
    'one': 1,
    'two': 2,
    'three': 3,
    'four': 4,
    'five': 5,
    'half': 0.5,
    'quarter': 0.25,
    'double': 2,
    'triple': 3,
    'couple': 2
  };
  const firstWord = cleaned.split(/\s+/)[0];
  if (wordAmounts[firstWord]) {
    const unit = cleaned.substring(firstWord.length).trim().replace(/s$/, '');
    return {
      amount: wordAmounts[firstWord],
      unit: unit || 'serving'
    };
  }
  const match = cleaned.match(/^([\d\/\.\s\-]+)\s*(.*)$/);
  if (!match) return null;
  let amountStr = match[1].trim();
  let amount;
  // Handle mixed fractions like "1 1/2"
  if (amountStr.includes(' ')) {
    const parts = amountStr.split(' ');
    amount = 0;
    for (const part of parts) {
      if (part.includes('/')) {
        const [num, den] = part.split('/').map(parseFloat);
        amount += num / den;
      } else {
        amount += parseFloat(part);
      }
    }
  } else if (amountStr.includes('/')) {
    const [num, den] = amountStr.split('/').map(parseFloat);
    amount = num / den;
  } else {
    amount = parseFloat(amountStr);
  }
  if (isNaN(amount)) return null;
  return {
    amount,
    unit: match[2].trim().replace(/s$/, '') || 'serving'
  };
}
function convertToGrams(amount, unit) {
  const units = {
    'g': 1,
    'gram': 1,
    'mg': 0.001,
    'milligram': 0.001,
    'kg': 1000,
    'kilogram': 1000,
    'oz': 28.35,
    'ounce': 28.35,
    'lb': 453.59,
    'pound': 453.59
  };
  return units[unit] ? amount * units[unit] : null;
}
function convertToMl(amount, unit) {
  const units = {
    'ml': 1,
    'milliliter': 1,
    'l': 1000,
    'liter': 1000,
    'tsp': 4.92,
    'teaspoon': 4.92,
    'tbsp': 14.78,
    'tablespoon': 14.78,
    'cup': 240,
    'fl oz': 29.57,
    'fluid ounce': 29.57,
    'pt': 473.17,
    'pint': 473.17,
    'qt': 946.35,
    'quart': 946.35,
    'gal': 3785.41,
    'gallon': 3785.41
  };
  return units[unit] ? amount * units[unit] : null;
}
export function scaleNutrition(data, multiplier) {
  const scaled = {
    ...data
  };
  const keysToScale = [
    'calories',
    'protein_g',
    'fat_total_g',
    'carbs_g',
    'fiber_g',
    'sugar_g',
    'sodium_mg',
    'fat_saturated_g',
    'cholesterol_mg',
    'potassium_mg',
    'fat_trans_g',
    'calcium_mg',
    'iron_mg',
    'magnesium_mg',
    'vitamin_a_mcg',
    'vitamin_c_mg',
    'vitamin_d_mcg',
    'sugar_added_g'
  ];

  if (multiplier !== 1) {
    keysToScale.forEach((key) => {
      if (typeof scaled[key] === 'number') {
        // @ts-ignore: key is valid
        scaled[key] = Math.round(scaled[key] * multiplier * 10) / 10;
        if (key === 'calories') scaled[key] = Math.round(scaled[key]);
      }
    });
  }

  // CRITICAL: Fallback for 0-calorie items that have macros
  if ((scaled.calories === 0 || !scaled.calories) &&
    ((scaled.protein_g || 0) > 0 || (scaled.carbs_g || 0) > 0 || (scaled.fat_total_g || 0) > 0)) {
    const calculatedCals = ((scaled.protein_g || 0) * 4) + ((scaled.carbs_g || 0) * 4) + ((scaled.fat_total_g || 0) * 9);
    if (calculatedCals > 0) {
      console.log(`[NutritionAgent] 0 calories detected with macros for ${scaled.food_name}. Calculating from macros: ${calculatedCals}`);
      scaled.calories = Math.round(calculatedCals);
      if (scaled.confidence === 'high') scaled.confidence = 'medium';
      if (!scaled.error_sources) scaled.error_sources = [];
      if (!scaled.error_sources.includes('calculated_from_macros')) {
        scaled.error_sources.push('calculated_from_macros');
      }
    }
  }

  return scaled;
}
export class NutritionAgent {
  name = 'nutrition';
  async execute(input, context) {
    const { items, portions, trackedNutrients } = input;
    const supabase = context.supabase || createAdminClient();
    const results = await Promise.all(items.map(async (itemName, i) => {
      const userPortion = portions[i] || '1 serving';
      const normalizedSearch = normalizeFoodName(itemName);

      // 1. Check Cache with normalized name
      const { data: cached } = await supabase.from('food_products').select('nutrition_data, product_name').ilike('search_term', normalizedSearch).limit(1).maybeSingle();
      let nutrition = null;

      if (cached) {
        console.log(`[NutritionAgent] Cache hit for ${itemName} (normalized: ${normalizedSearch})`);
        nutrition = cached.nutrition_data;
        // Validate cached data
        if (!isValidNutrition(nutrition, itemName)) {
          console.warn(`[NutritionAgent] Cached data for "${itemName}" has 0 calories, trying fallback`);
          nutrition = null; // Invalidate to trigger re-estimation
        }
      }

      // 2. Try LLM Estimation (PRIMARY source) if no cache
      if (!nutrition) {
        console.log(`[NutritionAgent] Cache miss for "${itemName}", trying LLM estimation (Primary)`);
        const estimation = await this.estimateNutritionWithLLM(itemName, trackedNutrients);

        if (estimation && isValidNutrition(estimation, itemName)) {
          nutrition = estimation;
          // Save LLM result to Cache
          try {
            await supabase.from('food_products').insert({
              product_name: estimation.food_name || itemName,
              search_term: normalizedSearch,
              nutrition_data: nutrition,
              calories: nutrition.calories,
              protein_g: nutrition.protein_g,
              carbs_g: nutrition.carbs_g,
              fat_total_g: nutrition.fat_total_g,
              source: 'agent',
              brand: 'AI Estimate'
            });
          } catch (err) {
            console.error('[NutritionAgent] Error saving LLM result to cache:', err);
          }
        } else {
          console.warn(`[NutritionAgent] LLM estimation failed or invalid for "${itemName}"`);
        }
      }

      // 3. Fallback to API Lookup if LLM fails
      if (!nutrition) {
        console.log(`[NutritionAgent] LLM failed for ${itemName}, failing back to APIs`);
        try {
          const lookupResult = await lookupNutrition(itemName);
          if (lookupResult.status === 'success' && lookupResult.nutrition_data) {
            nutrition = lookupResult.nutrition_data;
            // Validate API result
            if (!isValidNutrition(nutrition, itemName)) {
              console.warn(`[NutritionAgent] API result for "${itemName}" has 0 calories, trying fallback`);
              const fallback = findFallbackNutrition(itemName);
              if (fallback && isValidNutrition(fallback, itemName)) {
                nutrition = fallback;
              }
            }

            // Save API result to Cache
            if (nutrition) {
              await supabase.from('food_products').insert({
                product_name: lookupResult.product_name || itemName,
                search_term: normalizedSearch,
                nutrition_data: nutrition,
                calories: nutrition.calories,
                protein_g: nutrition.protein_g,
                carbs_g: nutrition.carbs_g,
                fat_total_g: nutrition.fat_total_g,
                source: lookupResult.source,
                brand: lookupResult.brand
              });
            }
          } else {
            // API returned no data - try fallback
            nutrition = findFallbackNutrition(itemName);
          }
        } catch (e) {
          console.error(`[NutritionAgent] API failure for ${itemName}:`, e);
          nutrition = findFallbackNutrition(itemName);
        }
      }

      if (!nutrition) {
        const fallback = findFallbackNutrition(itemName);
        if (fallback) nutrition = fallback;
      }

      if (nutrition) {
        // 4. Portion scaling
        const multiplier = await getScalingMultiplier(userPortion, nutrition.serving_size, itemName, supabase);
        console.log(`[NutritionAgent] Scaling ${itemName} by ${multiplier} (user: ${userPortion}, official: ${nutrition.serving_size})`);
        return scaleNutrition(nutrition, multiplier);
      } else {
        // Final failure log
        await logFailedLookup(itemName, 'No nutrition data available from Cache, LLM, or API', {
          supabase,
          userId: context.userId,
          portion: userPortion
        });
        return null; // Return something that will be filtered out or handled
      }
    }));
    return results.filter((r) => r !== null);
  }
  async estimateNutritionWithLLM(itemName, trackedNutrients = []) {
    try {
      const openai = createOpenAIClient();

      const extraNutrients = trackedNutrients.length > 0
        ? `\nIMPORTANT: Also estimate these specific nutrients if possible: ${trackedNutrients.join(', ')}.`
        : '';

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a nutrition expert. Estimate nutrition data for a given food item. 
            Return ONLY a JSON object matching this interface:
            {
              "food_name": string,
              "calories": number,
              "protein_g": number,
              "carbs_g": number,
              "fat_total_g": number,
              "fiber_g": number,
              "sugar_g": number,
              "sodium_mg": number,
              "fat_saturated_g": number,
              "cholesterol_mg": number,
              "potassium_mg": number,
              "calcium_mg": number,
              "iron_mg": number,
              "magnesium_mg": number,
              "vitamin_a_mcg": number,
              "vitamin_c_mg": number,
              "vitamin_d_mcg": number,
              "serving_size": string (e.g. "100g", "1 cup", "1 scoop")
              // Add other nutrients if requested
            }
            ${extraNutrients}
            
            Use these EXACT keys for specific nutrients if needed:
            ${Object.keys(MASTER_NUTRIENT_MAP).join(', ')}

            Be realistic. If a value is negligible (like fat in an apple), put 0, but do NOT put 0 for calories unless it's water/salt.
            If you are completely unsure, return null.`
          },
          {
            role: 'user',
            content: `Estimate nutrition for: "${itemName}"`
          }
        ],
        response_format: {
          type: 'json_object'
        }
      });
      const content = response.choices[0].message.content;
      if (!content) return null;
      const parsed = JSON.parse(content);
      if (!parsed || (parsed.calories === undefined && parsed.calories !== 0)) return null;

      const result = {
        food_name: parsed.food_name || itemName,
        calories: parsed.calories,
        protein_g: parsed.protein_g || 0,
        carbs_g: parsed.carbs_g || 0,
        fat_total_g: parsed.fat_total_g || 0,
        serving_size: parsed.serving_size || '100g',
        fiber_g: parsed.fiber_g || 0,
        sugar_g: parsed.sugar_g || 0,
        sodium_mg: parsed.sodium_mg || 0,
        fat_saturated_g: parsed.fat_saturated_g || 0,
        cholesterol_mg: parsed.cholesterol_mg || 0,
        potassium_mg: parsed.potassium_mg || 0,
        calcium_mg: parsed.calcium_mg || 0,
        iron_mg: parsed.iron_mg || 0,
        magnesium_mg: parsed.magnesium_mg || 0,
        vitamin_a_mcg: parsed.vitamin_a_mcg || 0,
        vitamin_c_mg: parsed.vitamin_c_mg || 0,
        vitamin_d_mcg: parsed.vitamin_d_mcg || 0
      };

      // Merge any other keys from parsed that might have been requested via trackedNutrients
      for (const key of trackedNutrients) {
        if (parsed[key] !== undefined && result[key] === undefined) {
          (result as any)[key] = parsed[key];
        }
      }

      return result;
    } catch (e) {
      console.error('[NutritionAgent] LLM estimation failed:', e);
      return null;
    }
  }
}
// Keep legacy export for now
export async function getNutritionForItems(items, portions) {
  const agent = new NutritionAgent();
  return agent.execute({
    items,
    portions
  }, {
    supabase: createAdminClient()
  });
}
