export interface NutrientValidationResult {
    valid: boolean;
    violations: string[];
}

export const NUTRIENT_HIERARCHY = {
    // Carbs Logic
    carbs_group: {
        parent: 'carbs_g',
        children: ['sugar_g', 'fiber_g'],
        strict: true // sum of known components <= parent
    },
    sugar_group: {
        parent: 'sugar_g',
        children: ['sugar_added_g'],
        strict: true
    },
    fiber_group: {
        parent: 'fiber_g',
        children: ['fiber_soluble_g'],
        strict: true
    },

    // Fat Logic
    fat_group: {
        parent: 'fat_total_g',
        children: ['fat_saturated_g', 'fat_poly_g', 'fat_mono_g', 'fat_trans_g'],
        strict: true
    },
    poly_fat_group: {
        parent: 'fat_poly_g',
        children: ['omega_3_g', 'omega_6_g'],
        strict: false // omega 3/6 are specific types, but there might be other poly fats
    }
};

export const NUTRIENT_NAMES: Record<string, string> = {
    carbs_g: 'Total Carbs',
    sugar_g: 'Total Sugars',
    fiber_g: 'Dietary Fiber',
    sugar_added_g: 'Added Sugars',
    fiber_soluble_g: 'Soluble Fiber',
    fat_total_g: 'Total Fat',
    fat_saturated_g: 'Saturated Fat',
    fat_poly_g: 'Polyunsaturated Fat',
    fat_mono_g: 'Monounsaturated Fat',
    fat_trans_g: 'Trans Fat',
    omega_3_g: 'Omega-3',
    omega_6_g: 'Omega-6'
};

/**
 * Validates that nutrient values respect the hierarchy (e.g. Sugar <= Carbs).
 */
export function validateNutrientHierarchy(nutrients: Record<string, any>): NutrientValidationResult {
    const violations: string[] = [];

    // Helper to safely get number
    const getVal = (key: string) => {
        const val = nutrients[key];
        return typeof val === 'number' && !isNaN(val) ? val : 0;
    };

    // Check Carbs Group (Individual Checks)
    if (getVal('sugar_g') > getVal('carbs_g')) {
        violations.push(`Total Sugars (${getVal('sugar_g')}g) cannot exceed Total Carbs (${getVal('carbs_g')}g)`);
    }
    if (getVal('fiber_g') > getVal('carbs_g')) {
        violations.push(`Dietary Fiber (${getVal('fiber_g')}g) cannot exceed Total Carbs (${getVal('carbs_g')}g)`);
    }
    // Check Carbs Group (Sum Check)
    // Note: Total Carbs = Sugar + Fiber + Starch. So Sugar + Fiber <= Total Carbs is a valid check.
    // We add a small epsilon (1g) for rounding errors.
    if (getVal('sugar_g') + getVal('fiber_g') > getVal('carbs_g') + 1) {
        violations.push(`Sum of Sugars (${getVal('sugar_g')}g) and Fiber (${getVal('fiber_g')}g) exceeds Total Carbs (${getVal('carbs_g')}g)`);
    }

    // Check Sugar Sub-group
    if (getVal('sugar_added_g') > getVal('sugar_g')) {
        violations.push(`Added Sugars (${getVal('sugar_added_g')}g) cannot exceed Total Sugars (${getVal('sugar_g')}g)`);
    }

    // Check Fat Group (Individual Checks)
    const fatComponents = ['fat_saturated_g', 'fat_poly_g', 'fat_mono_g', 'fat_trans_g'];
    for (const component of fatComponents) {
        if (getVal(component) > getVal('fat_total_g')) {
            violations.push(`${NUTRIENT_NAMES[component]} (${getVal(component)}g) cannot exceed Total Fat (${getVal('fat_total_g')}g)`);
        }
    }

    // Check Fat Group (Sum Check)
    // Sum of components <= Total Fat (allowing 1g buffer for rounding)
    const fatSum = fatComponents.reduce((sum, key) => sum + getVal(key), 0);
    if (fatSum > getVal('fat_total_g') + 1) {
        violations.push(`Sum of fat breakdown (${fatSum.toFixed(1)}g) exceeds Total Fat (${getVal('fat_total_g')}g)`);
    }

    // Check Poly Fat Sub-group
    if (getVal('omega_3_g') > getVal('fat_poly_g')) {
        violations.push(`Omega-3 (${getVal('omega_3_g')}g) cannot exceed Polyunsaturated Fat (${getVal('fat_poly_g')}g)`);
    }
    if (getVal('omega_6_g') > getVal('fat_poly_g')) {
        violations.push(`Omega-6 (${getVal('omega_6_g')}g) cannot exceed Polyunsaturated Fat (${getVal('fat_poly_g')}g)`);
    }

    return {
        valid: violations.length === 0,
        violations
    };
}

/**
 * Sanitizes nutrients by capping child values at parent values.
 * Useful for fixing minor rounding errors or AI hallucinations before display.
 * @returns A NEW object with sanitized values.
 */
export function sanitizeNutrients(nutrients: Record<string, any>): Record<string, any> {
    const sanitized = { ...nutrients };

    const cap = (child: string, parent: string) => {
        const childVal = sanitized[child];
        const parentVal = sanitized[parent];

        if (typeof childVal === 'number' && typeof parentVal === 'number') {
            if (childVal > parentVal) {
                console.warn(`[NutrientValidation] Capping ${child} (${childVal}) to ${parent} (${parentVal})`);
                sanitized[child] = parentVal;
            }
        }
    };

    // Cap Carbs Group
    cap('sugar_g', 'carbs_g');
    cap('fiber_g', 'carbs_g');
    cap('sugar_added_g', 'sugar_g');
    cap('fiber_soluble_g', 'fiber_g');

    // Cap Fat Group
    cap('fat_saturated_g', 'fat_total_g');
    cap('fat_poly_g', 'fat_total_g');
    cap('fat_mono_g', 'fat_total_g');
    cap('fat_trans_g', 'fat_total_g');
    cap('omega_3_g', 'fat_poly_g');
    cap('omega_6_g', 'fat_poly_g');

    return sanitized;
}

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
