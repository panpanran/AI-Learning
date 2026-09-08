import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App'
import Mistakes from './Mistakes'
import OAuthLogin from './OAuthLogin'
import AllCorrect from './AllCorrect'
import Results from './Results'
import HistoryRoute from './HistoryRoute'
import ScoresRoute from './ScoresRoute'
import FeedbackReview from './FeedbackReview'
import AppVersionBadge from './AppVersionBadge'
import { AuthAwareFallback, RedirectIfAuthed, RequireAuth } from './authGate'
import './i18n'
import './index.css'

createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <BrowserRouter>
            <AppVersionBadge />
            <Routes>
                <Route path="/" element={<RedirectIfAuthed><OAuthLogin /></RedirectIfAuthed>} />
                <Route path="/login" element={<RedirectIfAuthed><OAuthLogin /></RedirectIfAuthed>} />
                <Route path="/mistakes" element={<RequireAuth><Mistakes /></RequireAuth>} />
                <Route path="/results" element={<RequireAuth><Results /></RequireAuth>} />
                <Route path="/history" element={<RequireAuth><HistoryRoute /></RequireAuth>} />
                <Route path="/scores" element={<RequireAuth><ScoresRoute /></RequireAuth>} />
                <Route path="/feedback" element={<RequireAuth><FeedbackReview /></RequireAuth>} />
                <Route path="/all-correct" element={<RequireAuth><AllCorrect /></RequireAuth>} />
                <Route path="/app/*" element={<RequireAuth><App /></RequireAuth>} />
                <Route path="*" element={<AuthAwareFallback />} />
            </Routes>
        </BrowserRouter>
    </React.StrictMode>
)
