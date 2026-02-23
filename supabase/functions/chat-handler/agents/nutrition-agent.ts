// @ts-nocheck
import { lookupNutrition } from '../../_shared/nutrition-lookup.ts';
import { createAdminClient } from '../../_shared/supabase-client.ts';
import { createOpenAIClient } from '../../_shared/openai-client.ts';
import { normalizeFoodName } from '../../_shared/utils.ts';
import { MASTER_NUTRIENT_MAP } from '../../_shared/nutrient-validation.ts';
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

  // FIX: Branded item heuristic - "1 serving" = "1 sandwich/burger/bowl" for named foods
  const userLower = (userPortion || '').toLowerCase().trim();
  const servingLower = (servingSize || '').toLowerCase().trim();
  const descriptiveUnits = ['sandwich', 'burger', 'burrito', 'wrap', 'bowl', 'muffin', 'cookie',
    'donut', 'doughnut', 'bar', 'piece', 'slice', 'cup', 'can', 'bottle', 'packet',
    'box', 'taco', 'pizza', 'pie', 'bagel', 'biscuit', 'croissant', 'waffle', 'pancake',
    'nugget', 'wing', 'strip', 'patty', 'serving', 'container', 'pouch', 'bag', 'scoop'];
  const userMatch = userLower.match(/^(\d+\.?\d*)\s*(.+)$/);
  const servingMatch = servingLower.match(/^(\d+\.?\d*)\s*(.+)$/);
  if (userMatch && servingMatch) {
    const userCount = parseFloat(userMatch[1]);
    const servingCount = parseFloat(servingMatch[1]);
    const userUnit = userMatch[2].trim();
    const servingUnit = servingMatch[2].trim();
    // If user says "1 serving" and API says "1 [descriptor]" they mean the same thing
    if (userUnit === 'serving' && descriptiveUnits.some(d => servingUnit.includes(d))) {
      const multiplier = userCount / servingCount;
      console.log(`[NutritionAgent] Branded-item heuristic: "${userPortion}" = "${servingSize}" -> ${multiplier}`);
      return multiplier;
    }
    // If both are descriptive ("1 sandwich" = "1 sandwich"), same unit
    if (userUnit === servingUnit) {
      const multiplier = userCount / servingCount;
      console.log(`[NutritionAgent] Same-descriptor: "${userPortion}" / "${servingSize}" = ${multiplier}`);
      return multiplier;
    }
  }

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

  /**
  * UNIFIED ANALYSIS: The core engine of the NutritionAgent.
  * Replaces 5+ separate LLM calls with ONE efficient GPT-4o call.
  * 
  * Duties:
  * 1. Normalizes input ("egg" -> "Large Egg")
  * 2. Estimates nutrition (if cache miss)
  * 3. Calculates scaling (if portion provided)
  * 4. Extracts missing items (e.g. "with milk")
  */
  async analyzeNutrition(
    items: string[],
    portions: string[],
    originalContext: string,
    healthConstraints: any[] = [],
    memories: any[] = [],
    trackedNutrients: string[] = []
  ): Promise<any[]> {
    console.log('[NutritionAgent] Starting Unified Analysis for:', items);
    const openai = createOpenAIClient();

    // 1. First, check cache/API for each item (Fast Path)
    // We still want to use real API data if we have an exact/close match
    const initialResults = await Promise.all(items.map(async (item, i) => {
      const portion = portions[i] || '1 serving';

      // Try cache/API first (simulating the old check, but strictly for DB/API data)
      // If valid, return it. If not, return null to signal "needs LLM".
      // ... (Implementation detail: for speed, we might skip the detailed normalizeInput call here
      // and just try the raw name. If it fails, we let the LLM handle it all).

      try {
        const lookup = await lookupNutrition(item);
        if (lookup.status === 'success' && lookup.nutrition_data) {
          // We have data! Now we just need scaling.
          // For now, let's keep it simple: if API hits, use it.
          // Scaling might still need LLM if units don't match, but let's try rule-based first.
          const multiplier = await getScalingMultiplier(portion, lookup.nutrition_data.serving_size, item, null); // Pass null for supabase to skip cache for now
          return {
            type: 'api_hit',
            data: scaleNutrition(lookup.nutrition_data, multiplier),
            originalIndex: i
          };
        }
      } catch (e) {
        // API failed, proceed to LLM
      }
      return { type: 'needs_llm', item, portion, index: i };
    }));

    const itemsToAnalyze = initialResults.filter(r => r.type === 'needs_llm');
    const apiHits = initialResults.filter(r => r.type === 'api_hit').map(r => r.data);

    if (itemsToAnalyze.length === 0) {
      return apiHits;
    }

    // 2. Perform Unified LLM Analysis for the rest
    console.log(`[NutritionAgent] Analyzing ${itemsToAnalyze.length} items with LLM...`);

    const prompt = `
    You are an advanced nutrition engine. Analyze the user's food request.
    
    **INPUT**:
    Items: ${itemsToAnalyze.map((x: any) => `"${x.item}" (User portion: "${x.portion}")`).join(', ')}
    Original Context: "${originalContext}"
    
    **USER PROFILE**:
    Health Constraints: ${JSON.stringify(healthConstraints.map((c: any) => c.category))}
    Tracked Nutrients: ${trackedNutrients.join(', ')}

    **TASKS**:
    1. **Normalize**: Convert vague names to standard ones (e.g. "egg" -> "Large Egg").
    2. **Estimate**: Calculate nutrition for the *SPECIFIC* user portion.
       - **CRITICAL**: If the user specified a count (e.g. "2 eggs"), your \`serving_size\` string MUST reflect that count (e.g. "2 large eggs", NOT "1 serving").
       - If the user specified a weight, use it.
       - Use specific visual estimates if portion is vague (e.g. "bowl" -> ~400g).
    3. **Tracked Nutrients & Hydration**:
       - For EVERY nutrient listed in 'Tracked Nutrients' above, you MUST estimate a value and include it in the output.
       - **CRITICAL HYDRATION RULE**: You MUST populate \`hydration_ml\` for ANY food that contains water:
         - Liquids: water, coffee, tea, soup, milk, juice, etc. Use the volume directly (e.g., "500ml water" -> \`hydration_ml: 500\`).
         - Cooked/water-rich solid foods: eggs (~37ml per large egg), cooked pasta (~100ml per cup), cooked rice (~100ml per cup), fruits, vegetables, yogurt, stews, casseroles. Estimate the intrinsic water content.
         - Only set \`hydration_ml: 0\` for genuinely dry foods (crackers, chips, dried nuts, chocolate bars, candy, bread, etc.).
       - Do not omit tracked nutrients. If negligible, put 0.
    4. **Missing Items**: 
       - If the item is a dry powder (e.g. "protein powder", "collagen", "pre-workout") and NO liquid (water, milk, almond milk) is mentioned in the input or context:
         - Set \`is_missing_item: true\`.
         - Do NOT invent a liquid; just flag it so we can ask the user.
       - Did the user mention items in the context that aren't in the list? Add them as new results.
    5. **Nutrient Hierarchy Consistency**: Your fat subtypes MUST be consistent:
       - \`fat_poly_g\` >= \`omega_3_g\` + \`omega_6_g\`
       - \`fat_total_g\` >= \`fat_saturated_g\` + \`fat_poly_g\` + \`fat_mono_g\` + \`fat_trans_g\`
       - \`carbs_g\` >= \`sugar_g\` + \`fiber_g\`
       If you provide omega-3/omega-6, you MUST also set \`fat_poly_g\` to at least their sum.
    6. **Safety**: Flag CRITICAL health conflicts (e.g. peanut allergy).
    
    **OUTPUT JSON**:
    {
      "results": [
        {
          "food_name": string, // Standardized name
          "serving_size": string,
          "calories": number,
          "protein_g": number,
          "carbs_g": number,
          "fat_total_g": number,
          "sugar_g": number,
          "fiber_g": number,
          "sodium_mg": number,
          "hydration_ml": number, // Estimated water content
          // ... INCLUDE ALL TRACKED NUTRIENTS HERE (e.g. "vitamin_c_mg": 12, "selenium_mcg": 5)
          // Supported keys: ${Object.keys(MASTER_NUTRIENT_MAP).join(', ')}
          "confidence": "high" | "medium" | "low",
          "health_flags": string[], 
          "is_missing_item": boolean
        }
      ]
    }
    `;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'system', content: prompt }],
        response_format: { type: 'json_object' }
      }, {
        timeout: 30000
      });

      const content = response.choices[0].message.content;
      const parsed = content ? JSON.parse(content) : { results: [] };

      // Post-LLM density check with requery for outliers
      const densityCheckedResults = await this.densityCheckAndRequery(
        parsed.results, itemsToAnalyze, openai
      );

      // Merge API hits with LLM results
      return [...apiHits, ...densityCheckedResults.map((r: any) => ({
        ...r,
        error_sources: r.confidence === 'low' ? ['llm_estimation'] : []
      }))];

    } catch (e) {
      console.error('[NutritionAgent] Unified analysis failed:', e);
      return apiHits;
    }
  }

  /**
   * Validates LLM nutrition estimates against known caloric density ranges.
   * If an estimate deviates >25% from expected density, requeries the LLM once
   * with a specific warning about the expected range.
   */
  private async densityCheckAndRequery(
    results: any[],
    itemsToAnalyze: any[],
    openai: any
  ): Promise<any[]> {
    const DENSITY_RANGES: Record<string, { min: number; max: number; label: string }> = {
      chicken: { min: 1.1, max: 2.0, label: 'chicken breast/thigh' },
      beef: { min: 1.5, max: 2.8, label: 'beef' },
      pork: { min: 1.4, max: 2.5, label: 'pork' },
      salmon: { min: 1.5, max: 2.3, label: 'salmon' },
      fish: { min: 0.8, max: 2.0, label: 'fish' },
      egg: { min: 1.3, max: 1.6, label: 'egg' },
      rice: { min: 1.1, max: 1.4, label: 'cooked rice' },
      pasta: { min: 1.3, max: 1.8, label: 'cooked pasta' },
      bread: { min: 2.4, max: 3.0, label: 'bread' },
      cheese: { min: 2.5, max: 4.5, label: 'cheese' },
      milk: { min: 0.4, max: 0.7, label: 'milk' },
      butter: { min: 7.0, max: 7.5, label: 'butter' },
      oil: { min: 8.5, max: 9.0, label: 'cooking oil' },
      potato: { min: 0.7, max: 1.0, label: 'potato' },
      banana: { min: 0.8, max: 1.0, label: 'banana' },
      apple: { min: 0.5, max: 0.6, label: 'apple' },
      avocado: { min: 1.5, max: 1.8, label: 'avocado' },
      nut: { min: 5.5, max: 7.0, label: 'nuts' },
      tofu: { min: 0.7, max: 1.0, label: 'tofu' },
      yogurt: { min: 0.5, max: 1.2, label: 'yogurt' },
    };

    const flagged: { index: number; item: any; expected: { min: number; max: number; label: string }; portion: string; grams: number }[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const itemInfo = itemsToAnalyze[i];
      if (!r || !itemInfo) continue;

      const portionStr = (itemInfo.portion || '').toLowerCase();
      const gramsMatch = portionStr.match(/(\d+\.?\d*)\s*g/);
      if (!gramsMatch) continue;

      const grams = parseFloat(gramsMatch[1]);
      if (grams <= 0) continue;

      const density = (r.calories || 0) / grams;
      const itemLower = (itemInfo.item || '').toLowerCase();

      for (const [keyword, range] of Object.entries(DENSITY_RANGES)) {
        if (itemLower.includes(keyword)) {
          const expectedMid = (range.min + range.max) / 2;
          const deviation = Math.abs(density - expectedMid) / expectedMid;
          if (deviation > 0.25) {
            console.warn(`[NutritionAgent] Density outlier: "${itemInfo.item}" at ${density.toFixed(2)} kcal/g (expected ${range.min}-${range.max} for ${range.label})`);
            flagged.push({ index: i, item: itemInfo, expected: range, portion: portionStr, grams });
          }
          break;
        }
      }
    }

    if (flagged.length === 0) return results;

    // Requery flagged items once
    console.log(`[NutritionAgent] Requerying ${flagged.length} items with density guidance...`);
    const reqItems = flagged.map(f =>
      `"${f.item.item}" (portion: "${f.item.portion}") — Expected ${f.expected.min}-${f.expected.max} kcal/g for ${f.expected.label}. ` +
      `Your previous estimate was ${((results[f.index].calories || 0) / f.grams).toFixed(2)} kcal/g. ` +
      `Recalculate for EXACTLY ${f.grams}g.`
    ).join('\n');

    try {
      const reqPrompt = `You are a nutrition correction engine. The following items had caloric density outside expected ranges.
Recalculate nutrition for the EXACT portion specified. Use the density guidance to sanity-check your output.

${reqItems}

Return JSON: { "results": [ { "food_name": string, "serving_size": string, "calories": number, "protein_g": number, "carbs_g": number, "fat_total_g": number, ... } ] }`;

      const reqResponse = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'system', content: reqPrompt }],
        response_format: { type: 'json_object' }
      }, { timeout: 15000 });

      const reqContent = reqResponse.choices[0].message.content;
      const reqParsed = reqContent ? JSON.parse(reqContent) : { results: [] };

      if (reqParsed.results && reqParsed.results.length > 0) {
        flagged.forEach((f, fi) => {
          if (reqParsed.results[fi]) {
            const corrected = reqParsed.results[fi];
            const newDensity = (corrected.calories || 0) / f.grams;
            const expectedMid = (f.expected.min + f.expected.max) / 2;
            const newDeviation = Math.abs(newDensity - expectedMid) / expectedMid;

            if (newDeviation < 0.25) {
              console.log(`[NutritionAgent] Density correction accepted for "${f.item.item}": ${newDensity.toFixed(2)} kcal/g`);
              corrected.confidence = 'medium';
              if (!corrected.error_sources) corrected.error_sources = [];
              corrected.error_sources.push('density_corrected');
              results[f.index] = corrected;
            } else {
              console.warn(`[NutritionAgent] Requery still off for "${f.item.item}" (${newDensity.toFixed(2)} kcal/g). Keeping original.`);
            }
          }
        });
      }
    } catch (e) {
      console.error('[NutritionAgent] Density requery failed, keeping original estimates:', e);
    }

    return results;
  }

  async execute(input: any, context: any) {
    const { items, portions, trackedNutrients = [], originalDescription } = input;
    const healthConstraints = context.healthConstraints || [];
    const memories = context.memories || [];

    // Use the new Unified Analysis pipeline
    const results = await this.analyzeNutrition(
      items,
      portions,
      originalDescription || items.join(', '),
      healthConstraints,
      memories,
      trackedNutrients
    );

    return results;
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
