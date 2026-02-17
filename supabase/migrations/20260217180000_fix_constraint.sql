-- Drop the existing constraint (if it exists) to allow modification
ALTER TABLE "public"."user_goals" DROP CONSTRAINT IF EXISTS "user_goals_goal_type_check";

-- Allow ONLY 'goal' or 'limit'. Fix any existing bad data first.
UPDATE "public"."user_goals" 
SET goal_type = 'goal' 
WHERE goal_type NOT IN ('goal', 'limit');

-- Re-add the constraint allowing both 'goal' and 'limit'
ALTER TABLE "public"."user_goals" ADD CONSTRAINT "user_goals_goal_type_check" 
CHECK (goal_type IN ('goal', 'limit'));
