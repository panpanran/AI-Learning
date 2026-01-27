import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from '../App'
import API from '../api'
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../api')

describe('Diagnostic flow', () => {
    beforeEach(() => {
        // Ensure API methods exist and are reset
        if (!(API as any).post) (API as any).post = vi.fn()
        if (!(API as any).get) (API as any).get = vi.fn()
            (API as any).post.mockReset()
            (API as any).get.mockReset()
            // Provide a safe default for API.get used by the App's initial effect
            (API as any).get.mockResolvedValue({ data: { user: null } })
    })

    it('generates diagnostic and submits answers', async () => {
        // Mock login
        (API.post as any).mockImplementation((url: string, body: any) => {
            if (url === '/auth/mock-login') return Promise.resolve({ data: { token: 'tok', user: { id: 1, name: 'Demo' } } })
            if (url === '/api/generate/diagnostic') {
                return Promise.resolve({ data: { lessonId: 42, lesson: { title: 'Diag', explanation: 'Explain' }, questions: [{ id: 'q1', type: 'short', prompt: '1+1?', answer: '2' }, { id: 'q2', type: 'mcq', prompt: '2+2?', options: ['3', '4'], answer: '4' }] } })
            }
            if (url === '/api/submit/diagnostic') {
                return Promise.resolve({ data: { success: true, correctCount: 1, total: 2 } })
            }
            return Promise.resolve({ data: {} })
        })

        render(<App />)

        // Start learning -> login (use key text when i18n not initialized in test env)
        const startBtn = await screen.findByText(/start_learning|开始诊断|开始学习|Start Diagnostic|Start Learning/i)
        fireEvent.click(startBtn)

        // Click Start Diagnostic
        await waitFor(async () => {
            const diagBtn = await screen.findByText(/Start Diagnostic|诊断|start_diagnostic|开始诊断/i)
            fireEvent.click(diagBtn)
        })

        // Questions should appear
        await waitFor(() => expect(screen.getAllByText(/1\+1\?|2\+2\?/).length).toBeGreaterThan(0))

        // Fill answers
        const input = screen.getAllByPlaceholderText(/answer|回答/i)[0] as HTMLInputElement
        fireEvent.change(input, { target: { value: '2' } })

        // Submit all
        const submitAll = screen.getByText(/Submit all|提交全部|submit_all|提交全部/i)
        fireEvent.click(submitAll)

        await waitFor(() => expect(API.post).toHaveBeenCalledWith('/api/submit/diagnostic', expect.any(Object)))
    })
})
