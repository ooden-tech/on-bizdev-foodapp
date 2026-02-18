// utils/formatting.ts

// Basic number formatting (can be expanded)
export const formatNumber = (value: number | null | undefined, precision: number = 0): string => {
  if (value === null || value === undefined || isNaN(value)) return 'N/A';
  // Use 1 decimal place for values < 10 to preserve precision for small amounts
  const p = precision === 0 && (value > 0 && value < 10) ? 1 : precision;
  return value.toFixed(p);
};

// Specific Formatters (Metric Only)
export const formatWeight = (grams: number | null | undefined): string => {
  return `${formatNumber(grams, 0)} g`;
};

export const formatVolume = (milliliters: number | null | undefined): string => {
  return `${formatNumber(milliliters, 0)} ml`;
};

export const formatHeight = (heightCm: number | null | undefined): string => {
  return `${formatNumber(heightCm, 0)} cm`;
};

export const formatEnergy = (calories: number | null | undefined): string => {
  return `${formatNumber(calories, 0)} kcal`;
};

// Add other simple formatters as needed, e.g., for mg, mcg
export const formatMicrogram = (mcg: number | null | undefined): string => {
  return `${formatNumber(mcg, 0)} mcg`;
};

export const formatMilligram = (mg: number | null | undefined): string => {
  return `${formatNumber(mg, 0)} mg`;
};

import { MASTER_NUTRIENT_MAP } from 'shared';

// Example for nutrient display names (if needed elsewhere)
export const formatNutrientName = (key: string): string => {
  const normalizedKey = key.toLowerCase().trim();

  // 1. Check Master Map (Source of Truth)
  if (MASTER_NUTRIENT_MAP[normalizedKey]) {
    return MASTER_NUTRIENT_MAP[normalizedKey].name;
  }

  // Special cases for legacy or special aliases
  if (normalizedKey === 'hydration_ml') return 'Water';

  // 2. Fallback to formatting
  return key.replace(/_/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase())
    .replace(/ G$/, ' (g)')
    .replace(/ Mg$/, ' (mg)')
    .replace(/ Mcg$/, ' (mcg)')
    .replace(/ Ml$/, ' (ml)')
    .replace(/ Ug$/, ' (µg)');
};

// Generic formatter for nutrient values based on key
export const formatNutrientValue = (key: string, value: number | null | undefined): string => {
  if (value === null || value === undefined || isNaN(value)) return '-';

  const k = key.toLowerCase();
  if (k.endsWith('_mg')) return formatMilligram(value);
  if (k.endsWith('_mcg') || k.endsWith('_ug')) return formatMicrogram(value);
  if (k.endsWith('_ml')) return formatVolume(value);
  if (k.includes('calories') || k.includes('kcal')) return formatEnergy(value);
  if (k.endsWith('_g')) return formatWeight(value);

  return formatNumber(value, 0);
};