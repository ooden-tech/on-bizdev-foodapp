
# 1. Set a health constraint (e.g. Peanut Allergy)
# Expected: "I've noted your allergy to peanuts."
curl -X POST http://localhost:54321/functions/v1/chat-handler \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "I am allergic to peanuts",
    "session_id": "test_persistence_v1",
    "timezone": "UTC" 
  }'

# 2. Query a conflicting food (Peanut Butter) in a NEW session/turn
# Expected: Agent should warn about peanuts due to context injection
curl -X POST http://localhost:54321/functions/v1/chat-handler \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Can I have a peanut butter sandwich?",
    "session_id": "test_persistence_v1", 
    "timezone": "UTC"
  }'

# 3. Log a simple item (Chicken)
# Expected: response_type: "confirmation_food_log" with data.proposal
curl -X POST http://localhost:54321/functions/v1/chat-handler \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Log 200g chicken breast",
    "session_id": "test_modal_v1",
    "timezone": "UTC"
  }'
