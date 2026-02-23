# NutriPal Comprehensive Manual Test Flow

This document covers all core features, behaviors, and edge cases defined in the PRD, Architecture Specs, and Codebase.
**Format**: Each test acts as a manual script. Execute the message and verifying the result matches the expectation.

---

## Part 1: Foundation (Onboarding & Configuration)

### 1. Testing Goal Setting
**Message**: "Set my goals to 3000 calories, 200g protein, and 100g fat."
**Result**: succes


### 2. Testing Goal Recall
**Message**: "What are my current goals?"
**Result**: success

### 3. Testing Health Constraint Setup
**Message**: "I have a peanut allergy and I am lactose intolerant."
**Result**: success

### 4. Testing Constraint Verification
**Message**: "What are my health constraints?"
**Result**: success

## Part 2: Core Food Logging (The Happy Path)

### 5. Testing Simple Item Log
**Message**: "Log 2 boiled eggs."
**Result**: it logged it well, but “1 serving” is  confusing. it shoud have said 2 eggs

Water 0 ml is not  right (eggs contain plenty of water). we shoud have some water there.

### 6. Testing Multi-Item Log
**Message**: "Log 150g grilled chicken breast and a cup of white rice."
**Result**:Test Result – 150g Chicken + 1 Cup White Rice

Expected (approx):

~440–450 kcal

~49 g protein

~45 g carbs

~5–6 g fat

System Output:

370 kcal

35 g protein

45 g carbs

4 g fat

Conclusion:
Calories and protein are significantly undercounted. Carb value is correct (rice). Likely chicken portion scaling error (150g interpreted closer to ~100–110g).

### 7. Testing Brand/Specific Log
**Message**: "Log 1 Snickers Bar"
**Result**:ave failed with validation error
Error: “Omega-6 (0.8g) cannot exceed Polyunsaturated Fat (0g)”

Observed Data:

Polyunsaturated Fat: 0 g

Omega-6: 0.8 g

Conclusion:
Macro generation is internally inconsistent. Omega-6 is a subset of polyunsaturated fat, therefore polyunsaturated fat cannot be 0g if omega-6 is 0.8g. Validation correctly blocked save. Issue lies in nutrient generation/scaling logic, not validation layer.

### 8. Testing Confirmation Flow
**Message**: [After Step 7 Proposal] "Confirm."
**Result**: it works

### 9. Testing Cancellation
**Message**: "Log a pizza." -> [Wait for proposal] -> "Cancel."
**Result**:it works

---

## Part 3: Ambiguity & The "Thinking Partner"

### 10. Testing Ambiguity Detection (Size)
**Message**: "Log a bowl of pasta."
**Result**:successfully asked for clarification

### 11. Testing Clarification Response
**Message**: "It was a large serving of carbonara from a restaurant."
**Result**: success but Water = 0 ml again → hydration logic still inconsistent (same pattern as before)

### 12. Testing Vague Item
**Message**: "Log a sandwich."
**Result**: i clarified it was one slice toaster bread, one slice gouda cheese, one slice ham”

Observed Behavior

System treated ingredients separately

Asked unnecessary clarification for bread

Flagged ham due to macro inconsistency

Displayed merged entry: “White Bread Slice + 1 more”

Generated confusing confirmation flow

Expected Behavior

Recognize this as a simple sandwich

Aggregate into a single clear log entry (e.g., “Ham & Cheese Sandwich”)

No unnecessary clarification for standard items

No partial/fragmented confirmation

i dont like how it handled it, i dont need to log each ingridient seperatly, in case of chicken with rice is acceptable, but not great here it just doesnt make sense since i needed to log just the sandwich with macros calculated from ingridients i provided
---

## Part 4: Learning, Memory & Corrections



### 15. Testing Brand Learning
**Message**: "i usually eat Chobani Zero Sugar yogurt, 200 g, remember it"
**Result**: he said he remembered it 

### 16. Testing Brand Application
**Message**: "Log a yogurt."
**Result**: i started a new chat, he ask for specification, i said its the one i usually have and he correctly proposed the Chobani Zero Sugar yogurt, 200 g, so its a pass

---

## Part 5: Recipe Management

### 17. Testing Recipe Parsing (Save)
**Message**: "Save this recipe: Chicken Pesto Pasta. Ingredients: 500g Chicken Breast, 200g Pesto, 400g Penne Pasta. Serves 4."
**Result**: it did but total fat is 154g:

Sat 20g

Mono 91.5g

Omega-3 0.5g

Omega-6 4.4g

That leaves ~37g unaccounted (polyunsaturated etc).
And pesto should contain significant poly fat.

So fat subtype math looks inconsistent again.

### 18. Testing Recipe Confirmation
**Message**: "Yes, save it."
**Result**: success

### 19. Testing Recipe Logging
**Message**: "Log 1 serving of Chicken Pesto Pasta."
**Result**: it did say Just a heads up, logging this will bring your daily total to 3137 kcal. It also contains dairy, which may conflict with your health constraints, so please proceed with caution.
Would you like me to log this serving? 

**but it didnt show log food modal, however when i said yes to log it said it logged it and show the log food modal only then. The food was not logged tho and this log food modal showed only claories, all other macros were 0**

### 20. Testing Recipe Detail Query
**Message**: "What's in the Chicken Pesto Pasta?"
**Result**: sucess

---

## Part 6: Safety & Constraints

### 21. Testing Allergen Warning (Peanut)
**Message**: "Log a Snickers bar." [Recall Peanut Allergy from Test 3]
**Result**: 

### 22. Testing Intolerance Flag (Dairy)
**Message**: "Log a cheese sandwich." [Recall Lactose Intolerance]
**Result**: 

---

## Part 7: Analysis, Insights & What-Ifs

### 23. Testing Daily Summary
**Message**: "How am I doing today?"
**Result**:

### 24. Testing "What-If" Scenario (Planning)
**Message**: "If I eat a burger for dinner, will I go over my fat limit?"
**Result**: 

### 25. Testing Scenario Comparison
**Message**: "What about grilled salmon instead?"
**Result**: 

### 26. Testing Audit/Explanation
**Message**: "Why is my protein so high?"
**Result**: 

---

## Part 8: Edge Cases & Context

### 27. Testing Day Classification (Travel)
**Message**: "I'm traveling today, so I have less control over food."
**Result**: 

### 28. Testing Contextual Log (Travel Day)
**Message**: "Log a fast food burger."
**Result**: 

### 29. Testing Correction of Logged Item
**Message**: "Actually, that burger was a double."
**Result**: 

### 30. Testing "Delete" Command
**Message**: "Remove the last item."
**Result**: 
