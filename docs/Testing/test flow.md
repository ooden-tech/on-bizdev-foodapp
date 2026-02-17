# NutriPal Comprehensive Manual Test Flow

This document covers all core features, behaviors, and edge cases defined in the PRD, Architecture Specs, and Codebase.
**Format**: Each test acts as a manual script. Execute the message and verifying the result matches the expectation.

---

## Part 1: Foundation (Onboarding & Configuration)

### 1. Testing Goal Setting
**Message**: "Set my goals to 2400 calories, 180g protein, and 80g fat."
**Result**: it understood what i wanted and set calories and protein but not fat, even tho it said it did, when i mention that my total fat is still at 200 g, it gave me generic insight "t seems your total fat intake is significantly exceeding your goal of 80g", then i asked to set my fat gaol to 80 and it said "Updated your fat_total_g goal to 80g" but in reality in the dashboard my total fat is still at 200g

### 2. Testing Goal Recall
**Message**: "What are my current goals?"
**Result**: "Your current goals include a fat intake limit of 80g.
Note that you've consumed two portions of Big Mac, which significantly contributed to high calorie and fat levels today. Also, your hydration with 200 ml is a bit low—consider boosting your water intake!
Would you like to adjust any of your meals or set any new goals?" the answer is limited and generic, i dont fell like it was very usefull but not too bad

### 3. Testing Health Constraint Setup
**Message**: "I have a peanut allergy and I am lactose intolerant."
**Result**: "Just a heads up, I noted your peanut allergy and lactose intolerance. If you need help avoiding these in your meals or recipes, just let me know!

Your current nutrition goals are:
Calories: 2400 kcal
Protein: 180g
Carbohydrates: 200g
Fat: 80g
Sugar: 50g
Fiber: 100g
Trans Fat: 200g
Hydration: 2991 ml
If you’d like to adjust any goals or track something specific, I’m here to help!" It feels like context from previous message bleed over, also he mentions trans fat 200 and fat 80 while in the dashboard i have only fat total 200 g

### 4. Testing Constraint Verification
**Message**: "What are my health constraints?"
**Result**: "It seems I don't have any recorded health constraints for you yet. However, you've mentioned a peanut allergy and lactose intolerance. Would you like me to update your profile with these constraints, or are there any others to add?" when i said to update the profile he did this: "Your health profile has now been updated to include:
Peanut Allergy: Marked as critical.
Lactose Intolerance: Marked as a warning.
If you have any other dietary needs or restrictions you'd like to adjust, feel free to let me know!" and when i asked again what are my health constraints, he said what it was, peanuts and lactose. BUT, when i started new chat and asked What are my health constraints? he said "I'm here to help with your nutritional needs! If you have any specific allergies, intolerances, or medical conditions that I should keep in mind, please let me know, and I'll check for those!"---

## Part 2: Core Food Logging (The Happy Path)

### 5. Testing Simple Item Log
**Message**: "Log 2 boiled eggs."
**Result**: he calculated and logged it properly, only things is at it marked it as 1 serving with name Large egg, Boiled. Even tho nutrients were right amount for two eggs, not critical but a error nevertheles

### 6. Testing Multi-Item Log
**Message**: "Log 150g grilled chicken breast and a cup of white rice."
**Result**: he said "I've prepared the log for your grilled chicken breast and white rice. Please confirm if everything looks correct, and I'll log it for you!" but didnt show log food modal, when i said that i dont see anything, he said "It seems the meal you're trying to log would put you over your calorie goal for today. You've already consumed 2470 calories, while your target is 2400. Would you like to adjust your meal or proceed with the log anyway?", then i asked i dont see any log and he finally showed me log modal with name "Grilled Chicken Breast + 1 more" but macros seems right, In the dashboard, its two different logs, grilled chicken breast (150 g) and cooked white rice (1 cup)

### 7. Testing Brand/Specific Log
**Message**: "Log 1 scoop of Optimum Nutrition Gold Standard Whey."
**Result**: he said "Just a heads up, this whey protein contains dairy. Your current calorie intake is already 3340, exceeding your target of 2400. Would you like to proceed with logging it anyway?" but my dashboard showing me claories being at 1670 with goal of 2400, so  i dont understand what happened here. Also he did propose to log it and macros seem right, but he logging it as if i ate a dry scoop, he didnt ask what i mixed it with and didnt assume anything, but still, it is a bit dumb he proposed macros for dry scoop. When i clarified that i mixed it with 200 ml water, he corrected and added 200 ml water to the macros.

### 8. Testing Confirmation Flow
**Message**: [After Step 7 Proposal] "Confirm."
**Result**: succes

### 9. Testing Cancellation
**Message**: "Log a pizza." -> [Wait for proposal] -> "Cancel."
**Result**: He asked for clarification, which is good, macros seemes good, canceled successfully

---

## Part 3: Ambiguity & The "Thinking Partner"

### 10. Testing Ambiguity Detection (Size)
**Message**: "Log a bowl of pasta."
**Result**: [Should ask for clarification on size/type] success, he did just that

### 11. Testing Clarification Response
**Message**: "It was a large serving of carbonara from a restaurant."
**Result**: [Should propose estimation with Low Confidence warning]. He said "Just a heads up, this carbonara contains dairy, which may need to be considered based on your dietary preferences.
I found a match for a large serving of carbonara. Does this look right?" but no log modal was shown, when i said that i dont see anything he said "I apologize for the confusion! I can't log the carbonara yet because I need to clarify a couple of things.
Could you specify how large the serving was? Was it a regular portion, or would you consider it to be double the typical size? This will help me get it right!", i again clarifed and again he proposed the log without the modal, when i said i still dont see anything he again asked for clarification.

### 12. Testing Vague Item
**Message**: "Log a sandwich."
**Result**: [Should ask what kind of sandwich] succes, he did just that, when i specified that it was two slice of american toast bread, one slice of cheddar and 3 slice of salami, he propposed the log with right macros but **he didnt catch that chedder contains dairy, which is a problem**

---

## Part 4: Learning, Memory & Corrections

### 13. Testing Preference Learning
**Message**: "Log a latte." -> [Proposal uses Whole Milk] -> "No, I always drink oat milk."
**Result**: [Should update to Oat Milk and confirm memory storage]

### 14. Testing Preference Recall
**Message**: "Log another latte."
**Result**: [Should automatically propose Oat Milk]

### 15. Testing Brand Learning
**Message**: "When I say yogurt, I mean Chobani Zero Sugar."
**Result**: 

### 16. Testing Brand Application
**Message**: "Log a yogurt."
**Result**: [Should propose Chobani Zero Sugar]

---

## Part 5: Recipe Management

### 17. Testing Recipe Parsing (Save)
**Message**: "Save this recipe: Chicken Pesto Pasta. Ingredients: 500g Chicken Breast, 200g Pesto, 400g Penne Pasta. Serves 4."
**Result**: [Should show parsed ingredients and batch nutrition]

### 18. Testing Recipe Confirmation
**Message**: "Yes, save it."
**Result**: 

### 19. Testing Recipe Logging
**Message**: "Log 1 serving of Chicken Pesto Pasta."
**Result**: 

### 20. Testing Recipe Detail Query
**Message**: "What's in the Chicken Pesto Pasta?"
**Result**: 

---

## Part 6: Safety & Constraints

### 21. Testing Allergen Warning (Peanut)
**Message**: "Log a Snickers bar." [Recall Peanut Allergy from Test 3]
**Result**: [Should propose but include strong warning about peanuts]

### 22. Testing Intolerance Flag (Dairy)
**Message**: "Log a cheese sandwich." [Recall Lactose Intolerance]
**Result**: [Should flag dairy content]

---

## Part 7: Analysis, Insights & What-Ifs

### 23. Testing Daily Summary
**Message**: "How am I doing today?"
**Result**: [Should show bullet points of progress vs goals]

### 24. Testing "What-If" Scenario (Planning)
**Message**: "If I eat a burger for dinner, will I go over my fat limit?"
**Result**: [Should calculate hygiene without logging]

### 25. Testing Scenario Comparison
**Message**: "What about grilled salmon instead?"
**Result**: 

### 26. Testing Audit/Explanation
**Message**: "Why is my protein so high?"
**Result**: [Should breakdown contributors]

---

## Part 8: Edge Cases & Context

### 27. Testing Day Classification (Travel)
**Message**: "I'm traveling today, so I have less control over food."
**Result**: [Should classify day as 'Travel' and adjust expectations]

### 28. Testing Contextual Log (Travel Day)
**Message**: "Log a fast food burger."
**Result**: [Should be non-judgmental]

### 29. Testing Correction of Logged Item
**Message**: "Actually, that burger was a double."
**Result**: [Should update the previous log]

### 30. Testing "Delete" Command
**Message**: "Remove the last item."
**Result**: 
