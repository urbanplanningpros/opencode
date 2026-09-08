# Spec

Name: Exit Strong game.
Trigger: Jeremy approved game build and requested Sol 5.6.
Input: canonical campaign content and bounded player choices.
Output: static game and decision record.
Tools: OpenAI/Codex and scoped GitHub/Sites operations.
Read/write: own game module only; earlier site read-only.
Provider: OpenAI only.
Failures: invalid move denied; corrupted save safely restarted; unavailable integration not claimed.
Verification: node scripts/release-check.mjs; resource violation checks; Sol review.
Confirmation: inferred from explicit proceed and gaming website clarification.
