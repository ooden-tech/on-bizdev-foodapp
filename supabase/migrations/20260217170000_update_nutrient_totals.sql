-- Migration: update_nutrient_totals_function

-- 1. Data Repair: Fix mismatched nutrient keys in user_goals
-- We presume the canonical keys are those in food_log columns (e.g., vitamin_a_mcg)
-- The Settings page was saving them as 'vitamin_a_mcg_rae', 'water_g', etc.
-- We update them to match the DB columns so the Dashboard can find them.

UPDATE "public"."user_goals" SET "nutrient" = 'vitamin_a_mcg' WHERE "nutrient" = 'vitamin_a_mcg_rae';
UPDATE "public"."user_goals" SET "nutrient" = 'hydration_ml' WHERE "nutrient" = 'water_g';
UPDATE "public"."user_goals" SET "nutrient" = 'folate_mcg' WHERE "nutrient" = 'folate_mcg_dfe';
UPDATE "public"."user_goals" SET "nutrient" = 'fat_poly_g' WHERE "nutrient" = 'fat_polyunsaturated_g';
UPDATE "public"."user_goals" SET "nutrient" = 'fat_mono_g' WHERE "nutrient" = 'fat_monounsaturated_g';

-- 2. Update get_daily_nutrient_totals to support ALL food_log columns
CREATE OR REPLACE FUNCTION "public"."get_daily_nutrient_totals"("p_user_id" "uuid", "p_nutrient_key" "text", "p_start_date" "text", "p_end_date" "text") RETURNS TABLE("day" "date", "total" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    -- Expanded validation list to include ALL food_log nutrient columns
    IF p_nutrient_key NOT IN (
        -- Macros & Energy
        'calories', 'protein_g', 'fat_total_g', 'carbs_g', 'fiber_g', 'sugar_g', 'sugar_added_g', 'hydration_ml',
        -- Minerals
        'sodium_mg', 'potassium_mg', 'calcium_mg', 'iron_mg', 'magnesium_mg', 'phosphorus_mg', 
        'zinc_mg', 'copper_mg', 'manganese_mg', 'selenium_mcg', 'cholesterol_mg',
        -- Fats
        'fat_saturated_g', 'fat_trans_g', 'fat_poly_g', 'fat_mono_g', 'omega_3_g', 'omega_6_g',
        -- Vitamins
        'vitamin_a_mcg', 'vitamin_c_mg', 'vitamin_d_mcg', 'vitamin_e_mg', 'vitamin_k_mcg',
        'thiamin_mg', 'riboflavin_mg', 'niacin_mg', 'pantothenic_acid_mg', 'vitamin_b6_mg',
        'biotin_mcg', 'folate_mcg', 'vitamin_b12_mcg'
    ) THEN
        -- Verify if it's a known computed key (like omega_ratio) or purely invalid
        -- For now, we raise exception if it's not a column we can sum.
        RAISE EXCEPTION 'Invalid nutrient key or not summable: %', p_nutrient_key;
    END IF;

    RETURN QUERY
    SELECT 
        (log_time AT TIME ZONE 'UTC')::DATE as day,
        COALESCE(SUM((CASE 
            -- Energy & Macros
            WHEN p_nutrient_key = 'calories' THEN calories
            WHEN p_nutrient_key = 'protein_g' THEN protein_g
            WHEN p_nutrient_key = 'fat_total_g' THEN fat_total_g
            WHEN p_nutrient_key = 'carbs_g' THEN carbs_g
            WHEN p_nutrient_key = 'fiber_g' THEN fiber_g
            WHEN p_nutrient_key = 'sugar_g' THEN sugar_g
            WHEN p_nutrient_key = 'sugar_added_g' THEN sugar_added_g
            WHEN p_nutrient_key = 'hydration_ml' THEN hydration_ml
            
            -- Fats
            WHEN p_nutrient_key = 'fat_saturated_g' THEN fat_saturated_g
            WHEN p_nutrient_key = 'fat_trans_g' THEN fat_trans_g
            WHEN p_nutrient_key = 'fat_poly_g' THEN fat_poly_g
            WHEN p_nutrient_key = 'fat_mono_g' THEN fat_mono_g
            WHEN p_nutrient_key = 'omega_3_g' THEN omega_3_g
            WHEN p_nutrient_key = 'omega_6_g' THEN omega_6_g
            WHEN p_nutrient_key = 'cholesterol_mg' THEN cholesterol_mg

            -- Minerals
            WHEN p_nutrient_key = 'sodium_mg' THEN sodium_mg
            WHEN p_nutrient_key = 'potassium_mg' THEN potassium_mg
            WHEN p_nutrient_key = 'calcium_mg' THEN calcium_mg
            WHEN p_nutrient_key = 'iron_mg' THEN iron_mg
            WHEN p_nutrient_key = 'magnesium_mg' THEN magnesium_mg
            WHEN p_nutrient_key = 'phosphorus_mg' THEN phosphorus_mg
            WHEN p_nutrient_key = 'zinc_mg' THEN zinc_mg
            WHEN p_nutrient_key = 'copper_mg' THEN copper_mg
            WHEN p_nutrient_key = 'manganese_mg' THEN manganese_mg
            WHEN p_nutrient_key = 'selenium_mcg' THEN selenium_mcg

            -- Vitamins
            WHEN p_nutrient_key = 'vitamin_a_mcg' THEN vitamin_a_mcg
            WHEN p_nutrient_key = 'vitamin_c_mg' THEN vitamin_c_mg
            WHEN p_nutrient_key = 'vitamin_d_mcg' THEN vitamin_d_mcg
            WHEN p_nutrient_key = 'vitamin_e_mg' THEN vitamin_e_mg
            WHEN p_nutrient_key = 'vitamin_k_mcg' THEN vitamin_k_mcg
            WHEN p_nutrient_key = 'thiamin_mg' THEN thiamin_mg
            WHEN p_nutrient_key = 'riboflavin_mg' THEN riboflavin_mg
            WHEN p_nutrient_key = 'niacin_mg' THEN niacin_mg
            WHEN p_nutrient_key = 'pantothenic_acid_mg' THEN pantothenic_acid_mg
            WHEN p_nutrient_key = 'vitamin_b6_mg' THEN vitamin_b6_mg
            WHEN p_nutrient_key = 'biotin_mcg' THEN biotin_mcg
            WHEN p_nutrient_key = 'folate_mcg' THEN folate_mcg
            WHEN p_nutrient_key = 'vitamin_b12_mcg' THEN vitamin_b12_mcg

            ELSE 0
        END))::FLOAT, 0) as total
    FROM food_log
    WHERE user_id = p_user_id
      AND log_time >= p_start_date::TIMESTAMP WITH TIME ZONE
      AND log_time <= p_end_date::TIMESTAMP WITH TIME ZONE
    GROUP BY day
    ORDER BY day ASC;
END;
$$;
