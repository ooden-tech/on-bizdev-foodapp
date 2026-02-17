export interface NutrientInfo {
  name: string;
  unit: string;
}

export const MASTER_NUTRIENT_MAP: Record<string, NutrientInfo> = {
  calories: { name: "Calories", unit: "kcal" },
  protein_g: { name: "Protein", unit: "g" },
  carbs_g: { name: "Carbs", unit: "g" },
  fat_total_g: { name: "Total Fat", unit: "g" },
  hydration_ml: { name: "Water", unit: "ml" },
  fat_saturated_g: { name: "Saturated Fat", unit: "g" },
  fat_poly_g: { name: "Polyunsaturated Fat", unit: "g" },
  fat_mono_g: { name: "Monounsaturated Fat", unit: "g" },
  fat_trans_g: { name: "Trans Fat", unit: "g" },
  omega_3_g: { name: "Omega-3 Fatty Acids", unit: "g" },
  omega_6_g: { name: "Omega-6 Fatty Acids", unit: "g" },
  omega_ratio: { name: "Omega 6:3 Ratio", unit: "" },
  fiber_g: { name: "Dietary Fiber", unit: "g" },
  fiber_soluble_g: { name: "Soluble Fiber", unit: "g" },
  sugar_g: { name: "Total Sugars", unit: "g" },
  sugar_added_g: { name: "Added Sugars", unit: "g" },
  cholesterol_mg: { name: "Cholesterol", unit: "mg" },
  sodium_mg: { name: "Sodium", unit: "mg" },
  potassium_mg: { name: "Potassium", unit: "mg" },
  calcium_mg: { name: "Calcium", unit: "mg" },
  iron_mg: { name: "Iron", unit: "mg" },
  magnesium_mg: { name: "Magnesium", unit: "mg" },
  phosphorus_mg: { name: "Phosphorus", unit: "mg" },
  zinc_mg: { name: "Zinc", unit: "mg" },
  copper_mg: { name: "Copper", unit: "mg" },
  manganese_mg: { name: "Manganese", unit: "mg" },
  selenium_mcg: { name: "Selenium", unit: "mcg" },
  vitamin_a_mcg: { name: "Vitamin A", unit: "mcg" },
  vitamin_c_mg: { name: "Vitamin C", unit: "mg" },
  vitamin_d_mcg: { name: "Vitamin D", unit: "mcg" },
  vitamin_e_mg: { name: "Vitamin E", unit: "mg" },
  vitamin_k_mcg: { name: "Vitamin K", unit: "mcg" },
  thiamin_mg: { name: "Thiamin (B1)", unit: "mg" },
  riboflavin_mg: { name: "Riboflavin (B2)", unit: "mg" },
  niacin_mg: { name: "Niacin (B3)", unit: "mg" },
  pantothenic_acid_mg: { name: "Pantothenic Acid (B5)", unit: "mg" },
  vitamin_b6_mg: { name: "Vitamin B6", unit: "mg" },
  biotin_mcg: { name: "Biotin (B7)", unit: "mcg" },
  folate_mcg: { name: "Folate (B9)", unit: "mcg" },
  vitamin_b12_mcg: { name: "Vitamin B12", unit: "mcg" },
};

export const normalizeNutrientKey = (key: string): string => {
  const k = key.toLowerCase().trim();
  if (k === 'calories' || k === 'kcal' || k === 'energy') return 'calories';
  if (k === 'protein') return 'protein_g';
  if (k === 'carbs' || k === 'carbohydrates') return 'carbs_g';
  if (k === 'fat') return 'fat_total_g';
  
  // Dynamic lookup
  for (const [masterKey, info] of Object.entries(MASTER_NUTRIENT_MAP)) {
    if (k === masterKey) return masterKey;
    if (k === info.name.toLowerCase()) return masterKey;
  }
  
  // Fallback for suffixes
  if (k.includes('protein')) return 'protein_g';
  if (k.includes('carb')) return 'carbs_g';
  if (k.includes('fat') && k.includes('sat')) return 'fat_saturated_g';
  if (k.includes('fat') && !k.includes('total')) return 'fat_total_g'; // Default "Fat" to Total Fat
  if (k.includes('fiber')) return 'fiber_g';
  if (k.includes('sugar')) return 'sugar_g';
  
  return key.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
};
