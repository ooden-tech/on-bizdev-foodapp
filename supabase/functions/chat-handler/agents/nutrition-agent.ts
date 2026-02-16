import { lookupNutrition } from '../../_shared/nutrition-lookup.ts';
import { createAdminClient } from '../../_shared/supabase-client.ts';
import { createOpenAIClient } from '../../_shared/openai-client.ts';
import { normalizeFoodName } from '../../_shared/utils.ts';
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
  console.log(`[NutritionAgent] Falling back to LLM for scaling: "${userPortion}" vs "${servingSize}"`);
  const openai = createOpenAIClient();
  const prompt = `
User portion: "${userPortion}"
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
  // 4. Save to cache if successful
  if (foodName && supabase && !isNaN(finalMultiplier)) {
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
    'lb': 453.59,
    'pound': 453.59,
    'scoop': 30, // Standard protein powder scoop
    'heaping scoop': 45, // Large/heaping scoop
    'small scoop': 15,
    'large scoop': 45
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
    'gallon': 3785.41,
    'bowl': 500, // Standard bowl ~2 cups
    'large bowl': 750,
    'small bowl': 300,
    'glass': 240,
    'mug': 350
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

  // CRITICAL: Fallback for 0-calorie items that have macros (Feature 3 fix)
  if ((scaled.calories === 0 || !scaled.calories) &&
    ((scaled.protein_g || 0) > 0 || (scaled.carbs_g || 0) > 0 || (scaled.fat_total_g || 0) > 0)) {
    const calculatedCals = ((scaled.protein_g || 0) * 4) + ((scaled.carbs_g || 0) * 4) + ((scaled.fat_total_g || 0) * 9);
    if (calculatedCals > 0) {
      console.log(`[NutritionAgent] 0 calories detected with macros for ${scaled.food_name}. Calculating from macros: ${calculatedCals}`);
      scaled.calories = Math.round(calculatedCals);
      // Degrade confidence if we had to calculate calories
      if (scaled.confidence === 'high') scaled.confidence = 'medium';
      if (!scaled.error_sources) scaled.error_sources = [];
      if (!scaled.error_sources.includes('calculated_from_macros')) {
        scaled.error_sources.push('calculated_from_macros');
      }
    }
  }

  return scaled;
}

export interface ConfidenceDetails {
  calories: 'low' | 'medium' | 'high';
  protein_g: 'low' | 'medium' | 'high';
  carbs_g: 'low' | 'medium' | 'high';
  fat_total_g: 'low' | 'medium' | 'high';
  [key: string]: 'low' | 'medium' | 'high' | undefined;
}

export interface EnrichedNutritionResult {
  food_name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_total_g: number;
  fiber_g?: number;
  sugar_g?: number;
  sodium_mg?: number;
  fat_saturated_g?: number;
  cholesterol_mg?: number;
  potassium_mg?: number;
  calcium_mg?: number;
  iron_mg?: number;
  magnesium_mg?: number;
  vitamin_a_mcg?: number;
  vitamin_c_mg?: number;
  vitamin_d_mcg?: number;
  serving_size?: string;
  confidence: 'low' | 'medium' | 'high';
  confidence_details?: ConfidenceDetails;
  error_sources: string[];
}

// Basic allergen keywords for heuristic checking
const ALLERGEN_KEYWORDS: Record<string, string[]> = {
  dairy: ['milk', 'cheese', 'yogurt', 'cream', 'butter', 'whey', 'casein', 'lactose', 'ghee', 'custard', 'ice cream'],
  gluten: ['wheat', 'bread', 'pasta', 'barley', 'rye', 'flour', 'cake', 'biscuit', 'cookie', 'cracker', 'malt', 'seitan'],
  peanut: ['peanut', 'groundnut'],
  treenut: ['almond', 'cashew', 'walnut', 'pecan', 'pistachio', 'hazelnut', 'macadamia', 'pine nut'],
  shellfish: ['shrimp', 'crab', 'lobster', 'prawn', 'mussel', 'clam', 'oyster', 'scallop', 'squid', 'octopus'],
  fish: ['fish', 'salmon', 'tuna', 'cod', 'trout', 'bass', 'snapper', 'sardine', 'anchovy'],
  soy: ['soy', 'tofu', 'edamame', 'tempeh', 'miso', 'natto'],
  egg: ['egg', 'mayonnaise', 'meringue', 'albumin']
};

export class NutritionAgent {
  name = 'nutrition';

  private checkHealthConstraints(foodName: string, constraints: any[]): string[] {
    const flags: string[] = [];
    const normalizedFood = foodName.toLowerCase();

    for (const constraint of constraints) {
      if (!constraint) continue;

      const category = constraint.category.toLowerCase();
      // 1. Direct match (e.g. constraint "strawberry" matches "strawberry jam")
      if (normalizedFood.includes(category)) {
        flags.push(`${constraint.severity === 'high' || constraint.severity === 'critical' ? 'CRITICAL: ' : ''}Contains ${category}`);
        continue;
      }

      // 2. Keyword check for common allergens
      const keywords = ALLERGEN_KEYWORDS[category];
      if (keywords) {
        for (const keyword of keywords) {
          if (normalizedFood.includes(keyword)) {
            if (normalizedFood.includes(keyword)) {
              flags.push(`${constraint.severity === 'high' || constraint.severity === 'critical' ? 'CRITICAL: ' : ''}May contain ${category} (${keyword})`);
              break;
            }
            break;
          }
        }
      }
    }
    return flags;
  }

  private async applyMemories(foodName: string, currentPortion: string, memories: any[]): Promise<{ portion: string, refinedFoodName?: string, memory?: any }> {
    // REMOVED: Strict "isVague" check. We now apply memories even if portion is specific (e.g. "200ml coffee" + "with sugar").

    const normalizedFood = normalizeFoodName(foodName);
    const foodWords = new Set(normalizedFood.split(' '));

    // 1. Fast path: Heuristic matching
    for (const memory of memories) {
      if (memory.category === 'food' || memory.category === 'preferences') {
        const fact = memory.fact.toLowerCase();
        const normalizedFact = normalizeFoodName(fact);
        const factWords = normalizedFact.split(' ');

        // Check if any significant word from food name matches fact word (handles typos better if normalized name matches)
        const hasWordMatch = factWords.some(word => foodWords.has(word));

        if (hasWordMatch || fact.includes(normalizedFood) || normalizedFood.includes(fact)) {
          const matchPortion = fact.match(/(\d+(?:\.\d+)?\s*(?:g|oz|ml|cup|tbsp|tsp|slice|piece|large|medium|small))/i);
          // Only auto-apply portion from memory IF the current portion is vague.
          // If user said "200ml", we shouldn't overwrite it with "1 cup" from memory unless the memory is about ingredients.
          const isCurrentPortionVague = !currentPortion || currentPortion === '1 serving' || ['a', 'an', 'one'].includes(currentPortion.split(' ')[0].toLowerCase());

          if (matchPortion && isCurrentPortionVague) {
            console.log(`[NutritionAgent] Fast-path memory match for ${foodName}: ${matchPortion[1]}`);
            return { portion: matchPortion[1], memory };
          }
        }
      }
    }

    // 2. Slow path: LLM for complex matching (typos, detailed modifications)
    // Only do this if there are relevant-looking memories to save tokens
    const relevantMemories = memories.filter(m =>
      (m.category === 'food' || m.category === 'preferences') &&
      (normalizeFoodName(m.fact).split(' ').some(w => foodWords.has(w)) ||
        m.fact.toLowerCase().includes(foodName.toLowerCase().slice(0, 4)) ||
        foodName.toLowerCase().includes(m.fact.toLowerCase().slice(0, 4)))
    );

    if (relevantMemories.length > 0) {
      console.log(`[NutritionAgent] Calling LLM for memory matching: "${foodName}" with ${relevantMemories.length} memories`);
      const openai = createOpenAIClient();
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a nutrition assistant. A user wants to log "${foodName}" (portion: "${currentPortion}"). 
              Determine if any of these memories apply.
              
              Memories:
              ${relevantMemories.map((m, i) => `${i}. [${m.category}] ${m.fact}`).join('\n')}
              
              Return JSON: { "applies": boolean, "memory_index": number, "refined_portion": string, "refined_food_name": string }
              
              Rules:
              1. **Refined Name**: If a memory adds ingredients (e.g. "with sugar", "with milk"), ALWAYS include that in 'refined_food_name' (e.g. "coffee with sugar").
              2. **Portion**: Only suggest a 'refined_portion' if the user's input portion ("${currentPortion}") is vague (like "a cup", "1 serving"). If the user gave a specific amount (like "200ml", "50g"), LEAVE 'refined_portion' EMPTY/NULL to preserve their input.
              3. **Typos**: Handle typos gracefully (e.g. "coffe" -> "coffee").`
            }
          ],
          response_format: { type: "json_object" }
        });

        const result = JSON.parse(response.choices[0].message.content || '{}');
        if (result.applies && result.memory_index !== undefined && result.memory_index < relevantMemories.length) {
          const memory = relevantMemories[result.memory_index];
          console.log(`[NutritionAgent] LLM memory match: "${memory.fact}" -> portion: ${result.refined_portion}, name: ${result.refined_food_name}`);
          return {
            portion: result.refined_portion || currentPortion,
            refinedFoodName: result.refined_food_name,
            memory
          };
        }
      } catch (err) {
        console.error('[NutritionAgent] Error in LLM memory matching:', err);
      }
    }

    return { portion: currentPortion };
  }

  async execute(input: any, context: any) {
    const { items, portions, trackedNutrients = [], originalDescription } = input;
    const supabase = context.supabase || createAdminClient();
    const memories = context.memories || [];
    const healthConstraints = context.healthConstraints || [];

    const results = await Promise.all(items.map(async (rawItemName: string, i: number) => {
      let itemName = rawItemName;
      let userPortion = portions[i] || '1 serving';
      let appliedMemory = null;

      // 0. Feature 6: Apply Memories (Smarter matching for typos/ingredients)
      if (memories.length > 0) {
        const memoryResult = await this.applyMemories(itemName, userPortion, memories);
        if (memoryResult.memory) {
          userPortion = memoryResult.portion;
          appliedMemory = memoryResult.memory;
          if (memoryResult.refinedFoodName) {
            itemName = memoryResult.refinedFoodName;
          }
          // Mark memory as used (async, fire and forget)
          if (context.db) {
            context.db.markMemoryUsed(appliedMemory.id).catch((e: any) => console.error('Failed to mark memory used', e));
          }
        }
      }

      // 0. Step 1: Normalization (Pre-computation) - Feature Fix for Issue 2
      const normalizedInput = await this.normalizeInput(itemName, userPortion);
      const searchName = normalizedInput.canonical_name;
      const searchPortion = normalizedInput.quantity_amount ? `${normalizedInput.quantity_amount} ${normalizedInput.quantity_unit}` : userPortion;

      // Extract hydration context if "water" or liquid mentioned in original text
      // (This helps if normalizeInput stripped it out)
      // Note: We rely on estimateNutritionWithLLM for the heavy lifting if cache miss.

      console.log(`[NutritionAgent] Normalized "${itemName}" (${userPortion}) -> "${searchName}" (${searchPortion})`);

      const normalizedSearch = normalizeFoodName(searchName);

      // 1. Check Cache with normalized name
      const { data: cached } = await supabase
        .from('food_products')
        .select('nutrition_data, product_name')
        .ilike('search_term', normalizedSearch)
        .limit(1)
        .maybeSingle();

      let nutrition: EnrichedNutritionResult | null = null;

      if (cached) {
        console.log(`[NutritionAgent] Cache hit for ${searchName} (normalized: ${normalizedSearch})`);
        nutrition = {
          ...cached.nutrition_data,
          confidence: 'high',
          error_sources: []
        };

        // Validate cached data
        if (!isValidNutrition(nutrition, searchName)) {
          // ... (existing fallback logic)
        }
      } else {
        // 2. Lookup from APIs
        console.log(`[NutritionAgent] Cache miss for ${searchName}, calling APIs`);
        try {
          const lookupResult = await lookupNutrition(searchName);
          if (lookupResult.status === 'success' && lookupResult.nutrition_data) {
            // ... (existing API logic)
          } else {
            // ... (existing fallback logic)
          }
        } catch (e) {
          // ... (existing error logic)
        }
      }

      if (nutrition) {
        // 4. Portion scaling
        const multiplier = await getScalingMultiplier(searchPortion, nutrition.serving_size, searchName, supabase);
        console.log(`[NutritionAgent] Scaling ${searchName} by ${multiplier} (user: ${searchPortion}, official: ${nutrition.serving_size})`);

        let scaled = scaleNutrition(nutrition, multiplier);

        // Feature 6: Check Health Constraints
        const healthFlags = this.checkHealthConstraints(searchName, healthConstraints);
        if (healthFlags.length > 0) {
          // @ts-ignore
          scaled.health_flags = healthFlags;
        }
        if (appliedMemory) {
          // @ts-ignore
          scaled.applied_memory = appliedMemory;
        }

        // Step 3: Internal Verification (Self-Reflection) - Feature Fix for Issue 2
        const verified = await this.verifyNutrition(itemName, searchPortion, scaled, trackedNutrients);

        return verified;

      } else {
        // 5. Final fallback: LLM Estimation
        console.log(`[NutritionAgent] No data from API/Cache for "${searchName}", trying LLM estimation`);
        // Pass the NORMALIZED name and portion to LLM, plus tracked nutrients and original text
        const estimation = await this.estimateNutritionWithLLM(
          searchName,
          searchPortion,
          healthConstraints,
          memories,
          trackedNutrients,
          originalDescription || itemName
        );

        if (estimation) {
          // ... (existing scaling logic)
          // Note: estimateNutritionWithLLM already tries to respect the portion, but we double check scaling if needed
          const multiplier = await getScalingMultiplier(searchPortion, estimation.serving_size, searchName, supabase);
          let scaled = scaleNutrition(estimation, multiplier);

          // ... (existing health flags logic)

          // Step 3: Internal Verification
          const verified = await this.verifyNutrition(itemName, searchPortion, scaled, trackedNutrients);
          return verified;
        } else {
          // ... (existing failure logic)
          return null;
        }
      }
    }));

    // Post-processing: Check if originalDescription mentions items NOT in the processed list
    // This handles cases like "log protein with 200ml water" where water isn't extracted as a separate item.
    // AI-powered, works for any secondary item (water, milk, butter, sides, condiments, etc.)
    if (originalDescription && items.length < 3) {
      try {
        const additionalItems = await this.extractMissingItems(originalDescription, items, trackedNutrients);
        if (additionalItems.length > 0) {
          console.log(`[NutritionAgent] Found ${additionalItems.length} additional items from context:`, additionalItems);
          const additionalResults = await Promise.all(additionalItems.map(async (item: { name: string, portion: string }) => {
            return this.estimateNutritionWithLLM(item.name, item.portion, healthConstraints, memories, trackedNutrients, originalDescription);
          }));
          results.push(...additionalResults.filter((r: any) => r !== null));
        }
      } catch (e) {
        console.error('[NutritionAgent] extractMissingItems error:', e);
      }
    }

    return results.filter((r) => r !== null);
  }

  /**
   * Step 1: Normalize ambiguous input into a canonical form.
   * "2 eggs" -> { canonical_name: "Large Egg (Whole, Raw)", quantity_amount: 100, quantity_unit: "g" }
   * "1 scoop whey" -> { canonical_name: "Whey Protein Powder Isolate", quantity_amount: 30, quantity_unit: "g" }
   */
  async normalizeInput(itemName: string, userPortion: string): Promise<{ canonical_name: string, quantity_amount?: number, quantity_unit?: string, implid_unit?: string }> {
    try {
      const openai = createOpenAIClient();
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a normalization engine for nutrition data.
                    Your goal is to clarify ambiguous food names and portions into scientifcally standard forms.

                    **Rules**:
                    1. **Ambiguity Resolution**:
                       - "Whey" -> "Whey Protein Powder Isolate" (unless clearly liquid whey context).
                       - "Protein" -> "Protein Powder" default if unclear.
                       - "Egg" -> "Large Egg (Whole)".
                    2. **Portion Standardization**:
                       - Convert vague counts to grams if possible. E.g. "2 eggs" -> 100g.
                       - "1 scoop" -> ~30g (for powders).
                       - "Bowl" -> "Large Serving" or convert to ~400-500g (for meals like pasta).
                       - "Restaurant portion" -> "1.5 servings" (multiply standard by 1.5).
                    3. **Output**: JSON Only.
                    {
                        "canonical_name": string,
                        "quantity_amount": number | null,
                        "quantity_unit": string | null
                    }`
          },
          {
            role: "user",
            content: `Normalize: "${itemName}", Portion: "${userPortion}"`
          }
        ],
        response_format: { type: "json_object" }
      });

      const content = response.choices[0].message.content;
      const parsed = content ? JSON.parse(content) : {};
      return {
        canonical_name: parsed.canonical_name || itemName,
        quantity_amount: parsed.quantity_amount,
        quantity_unit: parsed.quantity_unit
      };
    } catch (e) {
      console.error('[NutritionAgent] Normalization failed:', e);
      return { canonical_name: itemName };
    }
  }

  /**
   * Step 3: Verify the final nutrition data against common sense.
   * Dynamically verifies ALL tracked nutrients, not just hardcoded macros.
   */
  async verifyNutrition(originalItem: string, originalPortion: string, data: any, trackedNutrients: string[] = []): Promise<any> {
    // Dynamically verify ALL tracked nutrients, not just hardcoded macros.
    try {
      const openai = createOpenAIClient();
      // Build dynamic nutrient data from whatever the user tracks
      const baseKeys = ['calories', 'protein_g', 'carbs_g', 'fat_total_g'];
      const allKeys = Array.from(new Set([...baseKeys, ...trackedNutrients]));
      const nutrientData: Record<string, any> = {};
      for (const key of allKeys) {
        if (data[key] !== undefined && data[key] !== null) {
          nutrientData[key] = data[key];
        }
      }

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a specific Nutrition Validator.
                      Review the nutrition data generated for the user's request.
                      
                      **Goal**: Catch HALLUCINATIONS or SCALING ERRORS.
                      
                      **Context**:
                      - User Request: "${originalItem} ${originalPortion}"
                      - Generated Data: ${JSON.stringify(nutrientData)}
                      
                      **Validation Rules**:
                      1. Calories must roughly match macros: (protein_g*4 + carbs_g*4 + fat_total_g*9). If macros imply >2x or <0.5x stated calories, WRONG.
                      2. Check each nutrient for plausibility given the food and portion. Flag obviously too high or too low values.
                      3. Common sense: protein powder scoop ~24g protein (not 120g), bowl of rice ~45g carbs (not 200g), egg ~6g protein.
                      
                      **Output**:
                      Return JSON:
                      {
                          "status": "valid" | "invalid",
                          "reason": string,
                          "corrected_data": { "calories": number, "protein_g": number, "carbs_g": number, "fat_total_g": number } | null
                      }
                      If "invalid", provide the CORRECT values using the exact key names: calories, protein_g, carbs_g, fat_total_g.`
          },
          { role: "user", content: "Verify this data." }
        ],
        response_format: { type: "json_object" }
      });

      const content = response.choices[0].message.content;
      const verification = content ? JSON.parse(content) : { status: "valid" };

      if (verification.status === "invalid" && verification.corrected_data) {
        console.warn(`[NutritionAgent] Verification FAILED for ${originalItem}. Correcting... Reason: ${verification.reason}`);
        // FIX: Normalize corrected_data keys to match data schema.
        // Previously, LLM returned {protein: 24} but data uses protein_g, so merge silently failed.
        const corrected = verification.corrected_data;
        const normalizedCorrection: Record<string, any> = {};
        for (const [key, val] of Object.entries(corrected)) {
          // Map common short names to schema names
          if (key === 'protein') normalizedCorrection['protein_g'] = val;
          else if (key === 'carbs') normalizedCorrection['carbs_g'] = val;
          else if (key === 'fat' || key === 'fat_total') normalizedCorrection['fat_total_g'] = val;
          else normalizedCorrection[key] = val;
        }
        return {
          ...data,
          ...normalizedCorrection,
          confidence: 'medium', // Downgrade confidence if we had to correct
          error_sources: [...(data.error_sources || []), 'verification_correction']
        };
      }

      return data;

    } catch (e) {
      console.error('[NutritionAgent] Verification error:', e);
      return data; // Return original if verification fails
    }
  }

  /**
   * AI-powered: Extract additional food items/beverages from the original description
   * that weren't captured as explicit items. Handles water, milk, sides, condiments, etc.
   */
  async extractMissingItems(originalDescription: string, processedItems: string[], trackedNutrients: string[]): Promise<{ name: string, portion: string }[]> {
    try {
      const openai = createOpenAIClient();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a nutrition context analyzer. The user described what they ate/drank, and we already extracted specific items from their description. Your job is to identify any ADDITIONAL food items or beverages mentioned that we missed.

Rules:
- Only return items explicitly mentioned or strongly implied in the description.
- Do NOT invent items that aren't there.
- Water, milk, juice, and other beverages count as separate items.
- Condiments, sides, and mix-ins count if explicitly mentioned (e.g. "with butter", "with ketchup").
- If no additional items are found, return an empty array.

User's tracked nutrients: ${trackedNutrients.join(', ') || 'calories, protein, carbs, fat'}

Return JSON: { "additional_items": [{ "name": string, "portion": string }] }`
          },
          {
            role: 'user',
            content: `Original description: "${originalDescription}"
Already processed items: ${JSON.stringify(processedItems)}

Are there additional items in the description that we missed?`
          }
        ],
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0].message.content;
      const parsed = content ? JSON.parse(content) : { additional_items: [] };
      return parsed.additional_items || [];
    } catch (e) {
      console.error('[NutritionAgent] extractMissingItems error:', e);
      return [];
    }
  }

  async estimateNutritionWithLLM(
    itemName: string,
    userPortion?: string,
    healthConstraints?: any[],
    memories?: any[],
    trackedNutrients: string[] = [],
    originalDescription?: string
  ): Promise<EnrichedNutritionResult | null> {
    try {
      console.log(`[NutritionAgent] Estimating for: "${itemName}" (Portion: ${userPortion || 'N/A'})`);
      const openai = createOpenAIClient();

      let contextualPrompt = '';
      if (healthConstraints && healthConstraints.length > 0) {
        contextualPrompt += `\n**HEALTH CHECK**: The user has these constraints: ${healthConstraints.map((c: any) => `${c.category} (${c.severity})`).join(', ')}. If this food likely violates them, add a 'health_flags' string array to the response using "Contains [Category]" or "May contain [Category]".`;
      }

      if (memories && memories.length > 0) {
        const foodMemories = memories.filter(m => m.category === 'food' || m.category === 'preferences');
        if (foodMemories.length > 0) {
          contextualPrompt += `\n**USER PREFERENCES/HABITS**: Incorporate these habits if relevant to the food being estimated: ${foodMemories.map(m => m.fact).join('; ')}. If a memory specifies a preparation or added ingredient (e.g. "with sugar"), include that in your estimation.`;
        }
      }

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a nutrition expert. Estimate nutrition data for a given food item.
            
            **CRITICAL RULE: CONFIDENCE & PRECISION MATRIX**
            You must evaluate confidence based on TWO factors: **Identity Precision** and **Quantity Precision**.

            1. **IDENTITY PRECISION**:
               - **Standardized/Specific** (High): Specific brands ("Oreo", "Big Mac"), biological standards ("Large Egg", "Banana"), or pure chemicals ("Sugar", "Salt").
               - **Variable** (Medium): Generic whole foods ("Chicken Breast", "Apple", "Steak").
               - **Highly Variable** (Low): Complex cooked dishes ("Lasagna", "Curry", "Sandwich", "Cake").

            2. **QUANTITY PRECISION**:
               - **Precise** (High): Exact weight ("100g") or standard count for standardized items ("1 cookie", "1 egg").
               - **Estimated** (Medium): Volume ("1 cup") or count for variable items ("1 breast").
               - **Vague** (Low): "A bowl", "some", "a serving".

            **SCORING RULES**:
            - **HIGH CONFIDENCE**: Identity is Standardized/Specific AND Quantity is Precise. (e.g. "1 Oreo", "100g Chicken").
            - **MEDIUM CONFIDENCE**: Identity is Variable OR Quantity is Estimated. (e.g. "1 Chicken Breast", "1 cup Rice").
            - **LOW CONFIDENCE**: Identity is Highly Variable OR Quantity is Vague. (e.g. "Lasagna", "bowl of chips").

            **SCIENTIFIC CONSISTENCY**:
            - Sugar <= Total Carbs
            - Fiber <= Total Carbs
            - Saturated Fat <= Total Fat
            - Poly + Mono + Sat + Trans <= Total Fat (approx)

            **Context Handling**:
            - The input might start with '[Context: ...]'. This is background.
            - **Specifics Override Context**: If the user provides a Specific Weight or Count in the new message, it INVALIDATES any vagueness in the Context. Treat the Context as resolved history.
            
            **Corrections**:
            - If the user says "actually" or corrects a number, the NEW number is the truth. Ignore the old one.

            ${contextualPrompt}
               
            **Output Format**:
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
              "serving_size": string (return the quantity you used, e.g. "200g"),
              "confidence": "low" | "medium" | "high",
              "confidence_details": {
                  "calories": "low" | "medium" | "high",
                  "protein_g": "low" | "medium" | "high",
                  "carbs_g": "low" | "medium" | "high",
                  "fat_total_g": "low" | "medium" | "high"
              },
              "error_sources": string[],
              "error_sources": string[],
              "health_flags": string[],
              "hydration_ml": number, // Explicitly track water/liquid content in ml
              // Dynamic fields for tracked nutrients
              [key: string]: any
            }
            If you are completely unsure, return null.`
          },
          {
            role: 'user',
            content: `Estimate nutrition for: "${itemName}". ${userPortion ? `User portion: "${userPortion}".` : ''}
          ${originalDescription && originalDescription !== itemName
                ? `\nOriginal user request: "${originalDescription}". If the original request mentions water, milk, or other liquid mixers, include the liquid volume in 'hydration_ml'.`
                : ''}
          
          CRITICAL INSTRUCTION: coverage of the quantity is MANDATORY.
          - If I provided a specific weight (e.g. "200g"), you MUST set 'serving_size' to that exact string.
          - You MUST calculate calories/macros for THAT specific amount.
          - Do NOT return "1 standard serving" if a specific quantity is provided.`
          }
        ],
        response_format: {
          type: 'json_object'
        }
      });

      const content = response.choices[0].message.content;
      console.log('[NutritionAgent] LLM Response:', content);
      if (!content) return null;

      const parsed = JSON.parse(content);
      if (!parsed.calories && parsed.calories !== 0) return null;

      const result: any = {
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
        vitamin_d_mcg: parsed.vitamin_d_mcg || 0,
        confidence: parsed.confidence || 'low',
        confidence_details: parsed.confidence_details || {
          calories: 'low',
          protein_g: 'low',
          carbs_g: 'low',
          fat_total_g: 'low'
        },
        error_sources: parsed.error_sources || ['llm_estimation'],
        // @ts-ignore
        health_flags: parsed.health_flags || []
      };

      // Add any tracked nutrients found in the response
      trackedNutrients.forEach(key => {
        if (parsed[key] !== undefined && result[key] === undefined) {
          result[key] = parsed[key];
        }
      });

      // Specifically ensure hydration_ml is captured if returned
      if (parsed.hydration_ml !== undefined) result.hydration_ml = parsed.hydration_ml;

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
