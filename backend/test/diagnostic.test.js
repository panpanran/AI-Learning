const request = require('supertest')
let app

const Ajv = require('ajv')
const diagSchema = require('../lib/schemas/diagnostic.schema')
const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(diagSchema)

// Mock OpenAI and Pinecone
const mockCreateCompletion = vi.fn()
const mockCreateEmbedding = vi.fn()

// We don't rely on vi.mock for openai or pinecone; instead, attach mocks to app.locals after requiring the app so the server uses those mocks via getOpenAI() and getPinecone().

describe('Diagnostic endpoints', () => {
    beforeAll(async () => {
        process.env.OPENAI_API_KEY = 'sk-test'
        process.env.NODE_ENV = 'test'
        app = require('../index') // will get exported app
        // Attach the mocked openai client to app.locals so the server uses it via getOpenAI()
        app.locals.openai = {
            chat: { completions: { create: mockCreateCompletion } },
            embeddings: { create: mockCreateEmbedding }
        };
        app.locals.pineconeClient = {
            queryByVector: vi.fn(async () => ({ matches: [{ id: 'u1', metadata: { subject: 'math' }, score: 0.9 }] })),
            embedTexts: vi.fn(async () => ([[0.1, 0.2]])),
            upsertVectors: vi.fn(async () => ({ upserted: true })),
            ensureConfigured: vi.fn()
        };
    })

    it('generate diagnostic returns JSON questions', async () => {
        const generated = {
            lesson: { title: 'Diag', explanation: 'Short diag', images: ['https://via.placeholder/1'] },
            questions: [
                {
                    id: 'q1',
                    type: 'mcq',
                    content_cn: '1+1等于多少？',
                    content_en: 'What is 1+1?',
                    options: { zh: ['1', '2', '3', '4'], en: ['1', '2', '3', '4'] },
                    answer_cn: '2',
                    answer_en: '2',
                    explanation_cn: '1+1=2',
                    explanation_en: '1+1=2',
                    knowledge_point_id: 1
                }
            ]
        };
        mockCreateCompletion.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(generated) } }] })
        mockCreateEmbedding.mockResolvedValueOnce({ data: [{ embedding: [0.1, 0.2] }] })

        // create user
        const login = await request(app).post('/auth/mock-login').send({ username: 't', password: 'pw', mode: 'register' })
        const token = login.body.token

        const resp = await request(app).post('/api/generate/diagnostic').send({ token, grade: 'G1', subject: 'math', lang: 'en' })
        expect(resp.status).toBe(200)
        expect(resp.body.generated).toBeTruthy()
        expect(Array.isArray(resp.body.questions)).toBe(true)
        expect(resp.body.questions[0].id).toBe('q1')

        // Validate structure with Ajv
        const toValidate = { lesson: resp.body.lesson, questions: resp.body.questions }
        const ok = validate(toValidate)
        if (!ok) console.error('Schema errors:', validate.errors)
        expect(ok).toBe(true)
    })

    it('submit diagnostic uses provided lesson without Pinecone writes', async () => {
        // Make one wrong answer: q1 answer is '2' but we send '3'
        mockCreateEmbedding.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] })
        app.locals.pineconeClient.upsertVectors.mockClear()
        const login = await request(app).post('/auth/mock-login').send({ username: 'u2', password: 'pw', mode: 'register' })
        const token = login.body.token

        const lesson = {
            questions: [
                {
                    id: 'q1',
                    type: 'mcq',
                    content_cn: '1+1等于多少？',
                    content_en: 'What is 1+1?',
                    options: { zh: ['1', '2', '3', '4'], en: ['1', '2', '3', '4'] },
                    answer_cn: '2',
                    answer_en: '2',
                    explanation_cn: '1+1=2',
                    explanation_en: '1+1=2',
                    knowledge_point_id: 1
                }
            ]
        }
        const resp = await request(app).post('/api/submit/diagnostic').send({ token, answers: [{ questionId: 'q1', answer: '3' }], lesson, lang: 'en' })
        expect(resp.status).toBe(200)
        expect(resp.body.success).toBe(true)
        expect(resp.body.total).toBe(1)
        // No per-user vectors are written to Pinecone
        expect(app.locals.pineconeClient.upsertVectors).not.toHaveBeenCalled()
    })
})
