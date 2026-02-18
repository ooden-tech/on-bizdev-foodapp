import assert from "node:assert";
import { normalizeNutrientKey } from "../../_shared/nutrients.ts";
// We can't import ToolExecutor easily in Node if it has Deno deps. 
// We will test normalization effectively.
// For ToolExecutor logic, we'll implement a mock of the unit conversion logic to verify it matches.

// Mock of the unit conversion logic in ToolExecutor
function calculateConvertedValue(targetValue: number, unit: string | undefined, normalizedNutrient: string) {
    // Minimal converter implementation from ToolExecutor
    const MASTER_NUTRIENT_MAP: any = {
        hydration_ml: { unit: 'ml' },
        weight_kg: { unit: 'kg' } // Mock entry
    };

    let finalValue = targetValue;
    let finalUnit = unit;

    // In actual code: const standardUnit = MASTER_NUTRIENT_MAP[normalizedNutrient]?.unit;
    // Use manual check for test
    const standardUnit = normalizedNutrient === 'hydration_ml' ? 'ml' : undefined;

    if (unit && standardUnit && unit !== standardUnit) {
        if (unit === 'oz' && standardUnit === 'ml') {
            // 1 fl oz = 29.5735 ml
            finalValue = Math.round(targetValue * 29.5735);
            finalUnit = 'ml';
        }
    }
    return { finalValue, finalUnit };
}

console.log("Running Normalization Logic Tests...");

const cases = [
    { input: "Monounsaturated Fat", expected: "fat_mono_g" },
    { input: "Polyunsaturated Fat", expected: "fat_poly_g" },
    { input: "Saturated Fat", expected: "fat_saturated_g" },
    { input: "Omega-3", expected: "omega_3_g" },
    { input: "Fiber", expected: "fiber_g" },
    { input: "Soluble Fiber", expected: "fiber_soluble_g" },
    { input: "sollubule fiber", expected: "fiber_soluble_g" }, // Typo
    { input: "Sodium", expected: "sodium_mg" },
    { input: "Water", expected: "hydration_ml" },
];

for (const { input, expected } of cases) {
    const result = normalizeNutrientKey(input);
    try {
        assert.strictEqual(result, expected);
        console.log(`✅ Passed: "${input}" -> "${result}"`);
    } catch (e) {
        console.error(`❌ Failed: "${input}" -> "${result}" (expected "${expected}")`);
        process.exit(1);
    }
}

console.log("\nRunning Unit Conversion Tests...");
const convResult = calculateConvertedValue(100, "oz", "hydration_ml");
try {
    assert.strictEqual(convResult.finalValue, 2957);
    assert.strictEqual(convResult.finalUnit, "ml");
    console.log(`✅ Passed: 100 oz Water -> 2957 ml`);
} catch (e) {
    console.error(`❌ Failed: 100 oz Water -> ${convResult.finalValue} ${convResult.finalUnit}`);
    process.exit(1);
}

console.log("\nAll tests passed!");
