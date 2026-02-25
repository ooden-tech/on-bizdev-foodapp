// utils/formatting.ts

// ===== Conversion Helpers =====
const ML_PER_OZ = 29.5735;
const G_PER_OZ = 28.3495;
const KJ_PER_KCAL = 4.184;

export type VolumeUnit = 'ml' | 'oz' | 'L';
export type WeightUnit = 'g' | 'oz' | 'lb';
export type EnergyUnit = 'kcal' | 'kj';

export interface DisplayUnits {
  volume?: VolumeUnit;
  weight?: WeightUnit;
  energy?: EnergyUnit;
}

const convertVolume = (ml: number, to: VolumeUnit): number => {
  if (to === 'oz') return ml / ML_PER_OZ;
  if (to === 'L') return ml / 1000;
  return ml;
};

const convertWeight = (g: number, to: WeightUnit): number => {
  if (to === 'oz') return g / G_PER_OZ;
  if (to === 'lb') return g / 453.592;
  return g;
};

const convertEnergy = (kcal: number, to: EnergyUnit): number => {
  if (to === 'kj') return kcal * KJ_PER_KCAL;
  return kcal;
};

const unitLabel = (unit: VolumeUnit | WeightUnit | EnergyUnit): string => {
  const labels: Record<string, string> = {
    ml: 'ml', oz: 'oz', L: 'L', g: 'g', lb: 'lb', kcal: 'kcal', kj: 'kJ'
  };
  return labels[unit] || unit;
};

// ===== Basic Number Formatting =====
export const formatNumber = (value: number | null | undefined, precision: number = 0): string => {
  if (value === null || value === undefined || isNaN(value)) return 'N/A';
  // Use 1 decimal place for values < 10 to preserve precision for small amounts
  const p = precision === 0 && (value > 0 && value < 10) ? 1 : precision;
  return value.toFixed(p);
};

// ===== Specific Formatters (unit-aware) =====
export const formatWeight = (grams: number | null | undefined, units?: DisplayUnits): string => {
  if (grams === null || grams === undefined || isNaN(grams)) return 'N/A';
  const u = units?.weight || 'g';
  return `${formatNumber(convertWeight(grams, u), 0)} ${unitLabel(u)}`;
};

export const formatVolume = (milliliters: number | null | undefined, units?: DisplayUnits): string => {
  if (milliliters === null || milliliters === undefined || isNaN(milliliters)) return 'N/A';
  const u = units?.volume || 'ml';
  return `${formatNumber(convertVolume(milliliters, u), u === 'L' ? 1 : 0)} ${unitLabel(u)}`;
};

export const formatHeight = (heightCm: number | null | undefined): string => {
  return `${formatNumber(heightCm, 0)} cm`;
};

export const formatEnergy = (calories: number | null | undefined, units?: DisplayUnits): string => {
  if (calories === null || calories === undefined || isNaN(calories)) return 'N/A';
  const u = units?.energy || 'kcal';
  return `${formatNumber(convertEnergy(calories, u), 0)} ${unitLabel(u)}`;
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

// Generic formatter for nutrient values based on key (unit-aware)
export const formatNutrientValue = (key: string, value: number | null | undefined, units?: DisplayUnits): string => {
  if (value === null || value === undefined || isNaN(value)) return '-';

  const k = key.toLowerCase();
  if (k.endsWith('_mg')) return formatMilligram(value);
  if (k.endsWith('_mcg') || k.endsWith('_ug')) return formatMicrogram(value);
  if (k.endsWith('_ml')) return formatVolume(value, units);
  if (k.includes('calories') || k.includes('kcal')) return formatEnergy(value, units);
  if (k.endsWith('_g')) return formatWeight(value, units);

  return formatNumber(value, 0);
};