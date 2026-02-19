/**
 * Batch Calculator
 * 
 * Estimates the total batch size (weight/volume) of a recipe
 * by summing up all ingredient quantities with proper unit conversions.
 */ import { normalizeUnit, convertToGrams, convertToMl, formatBatchSize, isVolumeUnit, isWeightUnit } from './portion-parser.ts';
// Average weights for common countable ingredients (in grams)
const COUNTABLE_WEIGHTS = {
  'egg': 50,
  'eggs': 50,
  'egg white': 33,
  'egg yolk': 17,
  'banana': 118,
  'apple': 182,
  'orange': 131,
  'lemon': 58,
  'lime': 44,
  'tomato': 123,
  'potato': 170,
  'sweet potato': 130,
  'onion': 110,
  'garlic clove': 3,
  'clove': 3,
  'cloves': 3,
  'carrot': 61,
  'celery stalk': 40,
  'stalk': 40,
  'avocado': 200,
  'chicken breast': 174,
  'chicken thigh': 116,
  'slice': 30,
  'piece': 100
};
/**
 * Calculate the total batch size of a recipe from its ingredients
 */ export function calculateBatchSize(ingredients) {
  let totalGrams = 0;
  let totalMl = 0;
  const breakdown = [];
  const unconverted = [];
  for (const ing of ingredients) {
    const portion = `${ing.quantity} ${ing.unit || ''}`;
    const normalizedUnit = normalizeUnit(ing.unit);
    let grams = null;
    let ml = null;
    let note;
    // Try direct weight conversion
    if (isWeightUnit(normalizedUnit)) {
      grams = convertToGrams(ing.quantity, normalizedUnit);
    } else if (isVolumeUnit(normalizedUnit)) {
      ml = convertToMl(ing.quantity, normalizedUnit);
      // Also try to get grams via density
      grams = convertToGrams(ing.quantity, normalizedUnit, ing.name);
      if (grams && !ml) {
        note = 'Converted from volume using density estimate';
      }
    } else {
      const countableWeight = findCountableWeight(ing.name, normalizedUnit);
      if (countableWeight !== null) {
        grams = ing.quantity * countableWeight;
        note = `Estimated weight: ${countableWeight}g each`;
      }
    }
    if (grams !== null) {
      totalGrams += grams;
    }
    if (ml !== null) {
      totalMl += ml;
    }
    if (grams === null && ml === null) {
      unconverted.push(ing.name);
    }
    breakdown.push({
      name: ing.name,
      grams,
      ml,
      originalPortion: portion,
      conversionNote: note
    });
  }
  // Determine confidence based on how many ingredients we could convert
  const convertedCount = ingredients.length - unconverted.length;
  const convertedRatio = ingredients.length > 0 ? convertedCount / ingredients.length : 0;
  let confidence;
  if (convertedRatio >= 0.9) {
    confidence = 'high';
  } else if (convertedRatio >= 0.6) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }
  return {
    totalGrams,
    totalMl,
    estimatedSize: formatBatchSize(totalGrams, totalMl),
    ingredientBreakdown: breakdown,
    unconvertedIngredients: unconverted,
    confidence
  };
}
/**
 * Find the weight of a countable item
 */ function findCountableWeight(ingredientName, unit) {
  const lower = ingredientName.toLowerCase();
  // Check the unit first (e.g., "2 eggs" where unit is "eggs")
  if (COUNTABLE_WEIGHTS[unit.toLowerCase()]) {
    return COUNTABLE_WEIGHTS[unit.toLowerCase()];
  }
  // Check ingredient name for known items
  for (const [key, weight] of Object.entries(COUNTABLE_WEIGHTS)) {
    if (lower.includes(key) || key.includes(lower)) {
      return weight;
    }
  }
  return null;
}
/**
 * Generate a human-friendly prompt asking the user to confirm batch size
 */ export function generateBatchConfirmationPrompt(result) {
  const { estimatedSize, unconvertedIngredients, confidence } = result;
  let prompt = `I've calculated that this recipe makes about **${estimatedSize}** total.`;
  if (confidence === 'low') {
    prompt += ` (Note: I couldn't determine the weight of some ingredients: ${unconvertedIngredients.join(', ')})`;
  } else if (confidence === 'medium') {
    prompt += ` (Some estimates were used)`;
  }
  prompt += `\n\nIs this correct? If not, please tell me the actual total size (e.g., "it makes 2 liters" or "about 1.5kg").`;
  return prompt;
}
/**
 * Parse a user's batch size response
 */ export function parseBatchSizeResponse(response) {
  const lower = response.toLowerCase().trim();
  // Check for confirmation
  if ([
    'yes',
    'yeah',
    'yep',
    'correct',
    'that\'s right',
    'looks good',
    'ok',
    'okay'
  ].some((phrase) => lower === phrase || lower.startsWith(phrase))) {
    return {
      confirmed: true
    };
  }
  // Check for explicit rejection with correction
  // Look for patterns like "no, it's 2 liters" or "actually about 1.5kg"
  const portionMatch = lower.match(/(\d+\.?\d*)\s*(kg|g|grams?|liters?|l|ml|oz|pounds?|lb|cups?)/i);
  if (portionMatch) {
    const amount = parseFloat(portionMatch[1]);
    const unit = portionMatch[2];
    const grams = convertToGrams(amount, unit);
    const ml = convertToMl(amount, unit);
    return {
      confirmed: false,
      correctedSize: `${amount} ${unit}`,
      grams: grams ?? undefined,
      ml: ml ?? undefined
    };
  }
  // If no clear answer, treat as rejection needing clarification
  return {
    confirmed: false
  };
}
