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

const SMALL_ITEMS_WHITELIST = [
  'garlic', 'chili', 'chilies', 'spice', 'spices', 'herb', 'herbs', 'tea',
  'zest', 'ginger', 'scallion', 'scallions', 'jalapeno', 'jalapeño',
  'bay leaf', 'bay leaves', 'nut', 'nuts', 'berry', 'berries', 'saffron',
  'pepper', 'leaf', 'leaves', 'clove', 'cloves'
];

// Track failed lookups for logging
const failedLookups = new Map();

function isStandardUnit(unit: string): boolean {
  if (!unit) return false;
  // Check macros lists in convertToGrams/Ml
  return ['g', 'gram', 'mg', 'milligram', 'kg', 'kilogram', 'oz', 'ounce', 'lb', 'pound',
    'ml', 'milliliter', 'l', 'liter', 'tsp', 'teaspoon', 'tbsp', 'tablespoon',
    'cup', 'fl oz', 'fluid ounce', 'pt', 'pint', 'qt', 'quart', 'gal', 'gallon'].includes(unit.toLowerCase());
}

function calculateHydration(itemName: string, amount: number, unit: string): number {
  const liquidKeywords = [
    'water', 'broth', 'stock', 'bouillon', 'consomme', 'soup',
    'milk', 'juice', 'tea', 'coffee', 'beer', 'wine', 'cider', 'soda', 'beverage', 'drink'
  ];
  const name = itemName.toLowerCase();

  // Must be a liquid type
  if (!liquidKeywords.some(k => name.includes(k))) return 0;

  // Must have a volumetric unit we can convert
  const ml = convertToMl(amount, unit);
  return ml || 0;
}
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

function checkNutrientGoals(ingredient: string, reason: string, context: any) {
  // Simple heuristic for now
  if (!context.goals) return [];
  // implementation...
  return [];
}

/**
 * Validates nutrition data to ensure it's not "empty" or "hollow"
 */
function isValidNutrition(data: any, itemName: string) {
  if (!data) return false;
  // Check essential fields
  if (data.calories === undefined && data.protein_g === undefined) return false;

  // Check for 0-calorie items that should have calories
  const likelyCaloric = /oil|butter|fat|sugar|syrup|honey|flour|rice|pasta|bread|meat|chicken|beef|pork|fish|egg|cheese|nut|seed|avocado/i;
  // If calories are 0 or very low, but it's a known caloric food
  if ((data.calories || 0) < 5 && likelyCaloric.test(itemName)) {
    console.warn(`[NutritionAgent] Warning: "${itemName}" has ${data.calories} calories, which seems too low.`);
    return false;
  }

  // Check for "Hollow Fat" (Total Fat > 1g but 0 Subtypes)
  if (data.fat_total_g > 1) {
    const subTypeSum = (data.fat_saturated_g || 0) +
      (data.fat_mono_g || 0) +
      (data.fat_poly_g || 0);

    if (subTypeSum < 0.1) {
      console.warn(`[NutritionAgent] Warning: Hollow Fat detected for "${itemName}" (Total: ${data.fat_total_g}, Subtypes: ${subTypeSum})`);
      return false;
    }
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
      const nToUnit = servingSize.toLowerCase().trim();
      const nFromUnit = userPortion.toLowerCase().trim();

      // Check standard 1:1 match
      const { data: cached } = await supabase.from('unit_conversions')
        .select('multiplier')
        .eq('food_name', normalizedFood)
        .eq('from_unit', nFromUnit)
        .eq('to_unit', nToUnit)
        .limit(1).maybeSingle();

      if (cached) {
        console.log(`[NutritionAgent] Conversion cache hit: ${userPortion} -> ${servingSize} = ${cached.multiplier}`);
        return cached.multiplier;
      }

      // Feature: Check "Gram Cache" for unitless items
      // If we are looking for "1 onion" -> "100g", we might have "onion" ("1 serving") -> "150g"
      if (userParsed && !isStandardUnit(userParsed.unit)) {
        const { data: gramCache } = await supabase.from('unit_conversions')
          .select('multiplier')
          .eq('food_name', normalizedFood)
          .eq('from_unit', userParsed.unit || 'serving')
          .eq('to_unit', 'g')
          .limit(1).maybeSingle();

        if (gramCache) {
          // gramCache.multiplier is the weight in grams of 1 unit
          const unitWeightGrams = gramCache.multiplier;
          // We need to convert to official serving size
          const officialGrams = convertToGrams(officialParsed?.amount || 100, officialParsed?.unit || 'g');

          if (officialGrams) {
            const totalGrams = unitWeightGrams * userParsed.amount;
            const multiplier = totalGrams / officialGrams;
            console.log(`[NutritionAgent] Gram cache hit: 1 ${userParsed.unit} = ${unitWeightGrams}g. Total ${totalGrams}g / ${officialGrams}g = ${multiplier}`);
            return multiplier;
          }
        }
      }
    } catch (err) {
      console.error('[NutritionAgent] Error checking conversion cache:', err);
    }
  }

  // 3. Special handling for Unitless/Count items (e.g. "1 onion", "2 carrots")
  const isCountTypes = userParsed && !isStandardUnit(userParsed.unit);

  if (isCountTypes) {
    console.log(`[NutritionAgent] Unitless item detected: "${userPortion}" (${foodName}). Estimating unit weight...`);
    // We need an agent to estimate "How many grams is 1 [unit] [foodName]?"
    const agent = new NutritionAgent();
    const estimatedGrams = await agent.estimateUnitWeight(foodName, userParsed?.unit || 'serving');

    if (estimatedGrams > 0) {
      // Save to Gram Cache
      if (supabase) {
        try {
          await supabase.from('unit_conversions').insert({
            food_name: foodName.toLowerCase().trim(),
            from_unit: (userParsed?.unit || 'serving').toLowerCase(),
            to_unit: 'g',
            multiplier: estimatedGrams // Storing WEIGHT as multiplier for 'g' target
          });
        } catch (err) { /* ignore */ }
      }

      // Calculate Multiplier against official
      // If official is "100g", we compare estimatedGrams * userAmount vs 100
      let officialGrams = 100;
      if (officialParsed) {
        const g = convertToGrams(officialParsed.amount, officialParsed.unit);
        if (g) officialGrams = g;
      }

      const totalUserGrams = estimatedGrams * (userParsed?.amount || 1);
      const multiplier = totalUserGrams / officialGrams;
      console.log(`[NutritionAgent] Count-to-Grams scaling: ${totalUserGrams}g / ${officialGrams}g = ${multiplier}`);
      return multiplier;
    }
  }

  // 4. Fallback to generic LLM for ambiguous descriptions (Legacy path)
  console.log(`[NutritionAgent] Falling back to generic LLM scaling: "${userPortion}" vs "${servingSize}" for "${foodName}"`);
  const openai = createOpenAIClient();
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
  const match = content?.match(/[\d\.]+/);
  const multiplier = match ? parseFloat(match[0]) : 1;
  const finalMultiplier = isNaN(multiplier) ? 1 : multiplier;

  // 5. Validate multiplier
  const SAFE_MIN = 0.05; // lowered slightly
  const SAFE_MAX = 20.0;

  // Check valid range
  if (finalMultiplier < SAFE_MIN || finalMultiplier > SAFE_MAX) {
    console.warn(`[NutritionAgent] Dangerous multiplier detected: ${finalMultiplier}. Defaulting to 1.`);
    return 1;
  }

  // Check "Hollow Unit" (Multiplier too small for a macroscopic count item)
  if (isCountTypes) {
    // If we ended up here (generic LLM), and we have "1 onion" -> 100g, and it returns 0.01 (1g), that's bad.
    // Heuristic: If implicit weight < 5g, and NOT standard unit, and NOT in whitelist.

    // Approx implied weight = finalMultiplier * officialGrams (assume 100g base if unknown)
    const impliedWeight = finalMultiplier * 100; // crude approx
    const isSmallItem = SMALL_ITEMS_WHITELIST.some(i => foodName.toLowerCase().includes(i));

    if (impliedWeight < 5 && !isSmallItem) {
      console.warn(`[NutritionAgent] Suspiciously small weight implied (${impliedWeight}g) for "${foodName}". Whitelist check failed. Defaulting to 1 to be safe.`);
      return 1;
    }
  }

  // 6. Save to cache if successful
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
function calculateSpecificNutrient(
  searchTerm: string,
  nutrition: any,
  portionGrams: number
): { amount: number; unit: string; confidence: string } | null {
  const nutrientMap: { [key: string]: string[] } = {
    'protein': ['protein_g'],
    'carbs': ['carbs_g', 'carbohydrates_total_g'],
    'fat': ['fat_total_g'],
    'fiber': ['fiber_g'],
    'sugar': ['sugar_g'],
    'sodium': ['sodium_mg'],
    'cholesterol': ['cholesterol_mg'],
    'saturated fat': ['fat_saturated_g'],
    'monounsaturated fat': ['fat_mono_g'],
    'polyunsaturated fat': ['fat_poly_g'],
    'trans fat': ['fat_trans_g'],
    'potassium': ['potassium_mg'],
    'calcium': ['calcium_mg'],
    'iron': ['iron_mg'],
    'vitamin a': ['vitamin_a_mcg'],
    'vitamin c': ['vitamin_c_mg'],
    'vitamin d': ['vitamin_d_mcg']
  };

  const normalizedSearchTerm = searchTerm.toLowerCase().trim();
  const nutrientKeys = nutrientMap[normalizedSearchTerm];

  if (!nutrientKeys) {
    return null; // Nutrient not recognized
  }

  let totalAmount = 0;
  let found = false;
  for (const key of nutrientKeys) {
    if (typeof nutrition[key] === 'number' && nutrition[key] > 0) {
      totalAmount += nutrition[key];
      found = true;
    }
  }

  if (!found) {
    return null; // Nutrient not found or is zero
  }

  // Assuming nutrition data is per 100g or per serving_size_g if available
  const baseGrams = nutrition.serving_size_g || 100; // Default to 100g if serving_size_g is not present

  if (baseGrams === 0) {
    console.warn(`[NutritionAgent] Cannot calculate specific nutrient for ${searchTerm}: baseGrams is 0.`);
    return null;
  }

  const scaledAmount = (totalAmount / baseGrams) * portionGrams;

  // Determine unit based on nutrient type
  let unit = 'g';
  if (normalizedSearchTerm.includes('sodium') || normalizedSearchTerm.includes('cholesterol') || normalizedSearchTerm.includes('potassium') || normalizedSearchTerm.includes('calcium') || normalizedSearchTerm.includes('iron') || normalizedSearchTerm.includes('vitamin c')) {
    unit = 'mg';
  } else if (normalizedSearchTerm.includes('vitamin a') || normalizedSearchTerm.includes('vitamin d')) {
    unit = 'mcg';
  }

  return {
    amount: Math.round(scaledAmount * 10) / 10, // Round to one decimal place
    unit: unit,
    confidence: nutrition.confidence || 'medium' // Inherit confidence from main nutrition data
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
  const keysToScale = Object.keys(MASTER_NUTRIENT_MAP);

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
        const estimation = await this.estimateNutritionWithLLM(itemName, trackedNutrients, context.recipeName);

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
            // Validate API result - STRICT REJECTION of Hollow Fat
            if (!isValidNutrition(nutrition, itemName)) {
              console.warn(`[NutritionAgent] API result for "${itemName}" is invalid/hollow. DISCARDING to force LLM retry.`);
              nutrition = null;
            } else {
              // Only save if valid
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
        const scaled = scaleNutrition(nutrition, multiplier);

        // 5. Add Water (Hydration)
        // Deterministic check based on unit and item keywords
        const parsedPortion = parseUnitAndAmount(userPortion);
        if (parsedPortion) {
          const hydration = calculateHydration(itemName, parsedPortion.amount, parsedPortion.unit);
          if (hydration > 0) {
            scaled.hydration_ml = hydration;
            console.log(`[NutritionAgent] Added hydration for ${itemName}: ${hydration}ml`);
          }
        }

        return scaled;
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

  async estimateUnitWeight(foodName: string, unit: string): Promise<number> {
    try {
      const openai = createOpenAIClient();
      const prompt = `
  You are an expert chef. What is the average weight in GRAMS of:
  "${unit}" of "${foodName}"?
  
  Examples: 
  - "1 whole" "Onion" -> 150
  - "1 clove" "Garlic" -> 5
  - "1 serving" "Spinach" -> 85
  
  Return ONLY the number (integer grams). If unsure or it varies wildy, return 0.
  `;
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 10
      });

      const content = response.choices[0].message.content?.trim();
      const match = content?.match(/[\d\.]+/);
      const grams = match ? parseFloat(match[0]) : 0;
      console.log(`[NutritionAgent] Estimated weight for 1 ${unit} ${foodName} = ${grams}g`);
      return grams;
    } catch (err) {
      console.error('[NutritionAgent] Error estimating unit weight:', err);
      return 0;
    }
  }

  async estimateNutritionWithLLM(itemName: string, trackedNutrients: string[] = [], recipeContext: string = '') {
    try {
      const openai = createOpenAIClient();

      const extraNutrients = trackedNutrients.length > 0
        ? `\nIMPORTANT: Also estimate these specific nutrients if possible: ${trackedNutrients.join(', ')}.`
        : '';

      const contextPrompt = recipeContext
        ? `\nCONTEXT: This ingredient is used in the recipe "${recipeContext}". Use this to infer if it's likely raw, cooked, or specific variety.`
        : '';

      let attempts = 0;
      const maxAttempts = 2;
      let messages = [
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
              "fat_mono_g": number, 
              "fat_poly_g": number,
              "omega_3_g": number,
              "omega_6_g": number,
              "cholesterol_mg": number,
              "potassium_mg": number,
              "calcium_mg": number,
              "iron_mg": number,
              "magnesium_mg": number,
              "vitamin_a_mcg": number,
              "vitamin_c_mg": number,
              "vitamin_d_mcg": number,
              "serving_size": string (e.g. "100g", "1 cup", "1 scoop")
            }
            
            IMPORTANT:
            - You MUST estimate values for ALL the above keys.
            - If a value is negligible (like fat in an apple), put 0.
            - Do NOT put 0 for calories unless it's water/salt/diet soda.
            - Accurately estimate FAT TYPES (saturated, mono, poly, omega-3, omega-6). Total Fat must roughly equal the sum of these.
            - If you are completely unsure about the item, return null. ${contextPrompt}`
        },
        {
          role: 'user',
          content: `Estimate nutrition for: "${itemName}"${extraNutrients}`
        }
      ];

      let parsed: any = null;

      while (attempts < maxAttempts) {
        attempts++;
        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: messages as any,
          response_format: { type: 'json_object' }
        });

        const content = response.choices[0].message.content;
        if (!content) return null;

        try {
          parsed = JSON.parse(content);
        } catch (e) {
          console.error('[NutritionAgent] Failed to parse JSON:', e);
          return null;
        }

        if (!parsed || (parsed.calories === undefined && parsed.calories !== 0)) return null;

        // Validation Check
        // We reconstruct a temporary result to check validity
        const tempCheck = {
          calories: parsed.calories,
          fat_total_g: parsed.fat_total_g || 0,
          fat_saturated_g: parsed.fat_saturated_g || 0,
          fat_mono_g: parsed.fat_mono_g || 0,
          fat_poly_g: parsed.fat_poly_g || 0,
          omega_3_g: parsed.omega_3_g || 0,
          omega_6_g: parsed.omega_6_g || 0
        };

        if (isValidNutrition(tempCheck as any, itemName)) {
          // Valid! Break loop
          break;
        } else {
          console.warn(`[NutritionAgent] LLM returned invalid/hollow data (Attempt ${attempts}/${maxAttempts}). Retrying...`);
          // Add error context to prompt for next try
          messages.push({ role: 'assistant', content });
          messages.push({
            role: 'user',
            content: `Your previous response had data integrity issues (e.g. Total Fat > 1g but 0g Saturated/Mono/Poly). You MUST estimate the fat subtypes.`
          });
          parsed = null; // Reset
        }
      }

      if (!parsed) return null; // Failed after retries

      const result: any = {
        food_name: parsed.food_name || itemName,
        serving_size: parsed.serving_size || '100g'
      };

      // Dynamically populate all known nutrients from the Master Map
      // This ensures we never "drop" a nutrient that the LLM provided (e.g. fat_mono_g, omega_3_g)
      Object.keys(MASTER_NUTRIENT_MAP).forEach(key => {
        // If the LLM provided it, use it. Otherwise default to 0.
        // Special case: don't overwrite if it was already set (though here we build fresh)
        result[key] = typeof parsed[key] === 'number' ? parsed[key] : 0;
      });

      // Explicitly preserve calories from parsed if it exists (sanity check)
      if (parsed.calories !== undefined) result.calories = parsed.calories;

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
