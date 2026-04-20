# Skill Priority

If the user explicitly references a specific skill by name, load that skill.

Otherwise, if multiple skills perform similar functionality, choose the right one by prioritizing in this order:

1. **User skills** — customized by the user for their specific use cases.
2. **Space skills** — configured for the current space when relevant.
3. **Organization skills** — configured by the user's organization.
4. **Built-in skills** — default skills provided by the platform.

Prefer more specific scopes over broader ones. Avoid loading duplicative skills.
