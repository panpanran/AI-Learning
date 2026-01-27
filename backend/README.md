# Backend for maxailearning

## Scripts

- npm run dev — start with nodemon
- npm start — start node

## Endpoints

- POST /auth/mock-login — body: { email, name } returns { token, user }
- GET /auth/google — placeholder for OAuth
- GET /me — requires Authorization: Bearer <token>
- POST /user/update — body: { token, grade, subject, lang }
- GET /api/today — requires Authorization: Bearer <token> returns generated or example lesson/homework

To enable OpenAI generation, set OPENAI_API_KEY in .env to a valid key and the endpoint will call model gpt-4.1.