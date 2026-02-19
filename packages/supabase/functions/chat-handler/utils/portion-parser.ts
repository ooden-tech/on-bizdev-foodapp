/**
 * Portion Parser Utilities
 * 
 * Provides functions to parse, normalize, and convert ingredient portions
 * for accurate batch size calculation and nutrition scaling.
 */ // Unit normalization maps
const UNIT_ALIASES = {
  // Volume units
  'cup': 'cup',
  'cups': 'cup',
  'c': 'cup',
  'tablespoon': 'tbsp',
  'tablespoons': 'tbsp',
  'tbsp': 'tbsp',
  'tbs': 'tbsp',
  'tb': 'tbsp',
  'teaspoon': 'tsp',
  'teaspoons': 'tsp',
  'tsp': 'tsp',
  'ts': 'tsp',
  't': 'tsp',
  'liter': 'liter',
  'liters': 'liter',
  'litre': 'liter',
  'litres': 'liter',
  'l': 'liter',
  'milliliter': 'ml',
  'milliliters': 'ml',
  'millilitre': 'ml',
  'ml': 'ml',
  'fluid ounce': 'fl oz',
  'fluid ounces': 'fl oz',
  'fl oz': 'fl oz',
  'fl. oz': 'fl oz',
  'floz': 'fl oz',
  'ounce': 'oz',
  'ounces': 'oz',
  'oz': 'oz',
  'quart': 'quart',
  'quarts': 'quart',
  'qt': 'quart',
  'pint': 'pint',
  'pints': 'pint',
  'pt': 'pint',
  'gallon': 'gallon',
  'gallons': 'gallon',
  'gal': 'gallon',
  // Weight units
  'gram': 'g',
  'grams': 'g',
  'g': 'g',
  'kilogram': 'kg',
  'kilograms': 'kg',
  'kg': 'kg',
  'pound': 'lb',
  'pounds': 'lb',
  'lb': 'lb',
  'lbs': 'lb',
  // Count units
  'piece': 'piece',
  'pieces': 'piece',
  'pc': 'piece',
  'pcs': 'piece',
  'slice': 'slice',
  'slices': 'slice',
  'whole': 'whole',
  'each': 'each',
  'serving': 'serving',
  'servings': 'serving'
};
// Conversion factors to grams for weight-based measurements
const TO_GRAMS = {
  'g': 1,
  'kg': 1000,
  'lb': 453.592,
  'oz': 28.3495
};
// Conversion factors to ml for volume-based measurements
const TO_ML = {
  'ml': 1,
  'liter': 1000,
  'cup': 236.588,
  'tbsp': 14.787,
  'tsp': 4.929,
  'fl oz': 29.5735,
  'quart': 946.353,
  'pint': 473.176,
  'gallon': 3785.41
};
// Approximate density conversions (ml to grams) for common ingredients
const INGREDIENT_DENSITIES = {
  'water': 1.0,
  'milk': 1.03,
  'cream': 0.99,
  'oil': 0.92,
  'olive oil': 0.92,
  'vegetable oil': 0.92,
  'safflower oil': 0.92,
  'honey': 1.42,
  'flour': 0.53,
  'sugar': 0.85,
  'brown sugar': 0.93,
  'salt': 1.22,
  'butter': 0.91,
  'broth': 1.0,
  'stock': 1.0,
  'chicken broth': 1.0,
  'beef broth': 1.0,
  'vegetable broth': 1.0,
  'juice': 1.05,
  'rice': 0.75,
  'oats': 0.41,
  'pasta': 0.45,
  'chicken': 0.8,
  'beef': 0.9,
  'pork': 0.9,
  'meat': 0.9,
  'tofu': 0.95,
  'yogurt': 1.03
};
/**
 * Parse a portion string into amount and unit
 * Handles fractions, decimals, and various formats
 */ export function parsePortion(text: string) {
  const original = text.trim();
  let workText = original.toLowerCase();
  // Handle common fractions
  workText = workText.replace(/½/g, '0.5').replace(/¼/g, '0.25').replace(/¾/g, '0.75').replace(/⅓/g, '0.333').replace(/⅔/g, '0.667').replace(/⅛/g, '0.125').replace(/⅜/g, '0.375').replace(/⅝/g, '0.625').replace(/⅞/g, '0.875');
  // Handle text fractions like "1/2", "3/4"
  workText = workText.replace(/(\d+)\s*\/\s*(\d+)/g, (_match: string, num: string, denom: string) => {
    return String(parseInt(num) / parseInt(denom));
  });
  // Handle mixed numbers like "1 1/2" or "2-1/4"
  workText = workText.replace(/(\d+)\s*[-\s]\s*(\d+\.?\d*)/g, (_match: string, whole: string, frac: string) => {
    return String(parseInt(whole) + parseFloat(frac));
  });
  // Handle "to taste" / "optional" / "garnish" -> 0 amount
  if (workText.includes('to taste') || workText.includes('optional') || workText.includes('garnish') || workText.includes('for serving')) {
    return {
      amount: 0,
      unit: 'to taste',
      originalText: original
    };
  }

  // Extract number and unit
  const match = workText.match(/^([0-9.]+)\s*(.*)$/);
  if (match) {
    const amount = parseFloat(match[1]);
    const unit = match[2].trim() || 'piece';
    return {
      amount,
      unit,
      originalText: original
    };
  }
  // No number found - assume 1 of whatever the text is
  return {
    amount: 1,
    unit: workText || 'piece',
    originalText: original
  };
}
/**
 * Normalize a unit to its canonical form
 */ export function normalizeUnit(unit: string | null | undefined): string {
  if (!unit || typeof unit !== 'string') return '';
  const lower = unit.toLowerCase().trim();
  return UNIT_ALIASES[lower] || lower;
}
/**
 * Check if a unit is a volume unit
 */ export function isVolumeUnit(unit) {
  const normalized = normalizeUnit(unit);
  return normalized in TO_ML;
}
/**
 * Check if a unit is a weight unit
 */ export function isWeightUnit(unit) {
  const normalized = normalizeUnit(unit);
  return normalized in TO_GRAMS;
}
/**
 * Convert a portion to grams
 * Returns null if conversion is not possible
 */ export function convertToGrams(amount, unit, ingredientName) {
  const normalized = normalizeUnit(unit);
  // Direct weight conversion
  if (normalized in TO_GRAMS) {
    return amount * TO_GRAMS[normalized];
  }
  // Volume to weight conversion (requires density)
  if (normalized in TO_ML && ingredientName) {
    const ml = amount * TO_ML[normalized];
    const density = findDensity(ingredientName);
    if (density !== null) {
      return ml * density;
    }
  }
  return null;
}
/**
 * Convert a portion to milliliters
 * Returns null if conversion is not possible
 */ export function convertToMl(amount, unit) {
  const normalized = normalizeUnit(unit);
  if (normalized in TO_ML) {
    return amount * TO_ML[normalized];
  }
  return null;
}
/**
 * Find the density multiplier for an ingredient
 * Returns null if not found
 */ function findDensity(ingredientName) {
  const lower = ingredientName.toLowerCase();
  // Check for exact match
  if (lower in INGREDIENT_DENSITIES) {
    return INGREDIENT_DENSITIES[lower];
  }
  // Check for partial match
  for (const [key, density] of Object.entries(INGREDIENT_DENSITIES)) {
    if (lower.includes(key) || key.includes(lower)) {
      return density;
    }
  }
  // Default density for liquids containing common keywords
  if (lower.includes('broth') || lower.includes('stock') || lower.includes('water')) {
    return 1.0;
  }
  if (lower.includes('oil')) {
    return 0.92;
  }
  if (lower.includes('milk') || lower.includes('cream')) {
    return 1.0;
  }
  return null;
}
/**
 * Fully normalize a portion with all conversions
 */ export function normalizePortion(portion, ingredientName) {
  const parsed = parsePortion(portion);
  const normalizedUnit = normalizeUnit(parsed.unit);
  return {
    ...parsed,
    normalizedUnit,
    inGrams: convertToGrams(parsed.amount, normalizedUnit, ingredientName),
    inMl: convertToMl(parsed.amount, normalizedUnit)
  };
}
/**
 * Format a gram amount to a human-readable string
 */ export function formatGrams(grams) {
  if (grams >= 1000) {
    return `${(grams / 1000).toFixed(1)}kg`;
  }
  return `${Math.round(grams)}g`;
}
/**
 * Format a milliliter amount to a human-readable string
 */ export function formatMl(ml) {
  if (ml >= 1000) {
    return `${(ml / 1000).toFixed(1)}L`;
  }
  return `${Math.round(ml)}ml`;
}
/**
 * Combine grams and ml into a combined size string
 */ export function formatBatchSize(grams, ml) {
  // If we have both, prefer the larger one
  // but also mention the other for clarity
  if (grams > 0 && ml > 0) {
    // If they're roughly equivalent (indicating we have conversions)
    // just show one
    return formatGrams(grams);
  }
  if (grams > 0) {
    return formatGrams(grams);
  }
  if (ml > 0) {
    return formatMl(ml);
  }
  return 'unknown';
}
