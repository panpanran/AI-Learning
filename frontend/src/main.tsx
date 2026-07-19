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
import AppVersionBadge from './AppVersionBadge'
import './i18n'
import './index.css'

createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <BrowserRouter>
            <AppVersionBadge />
            <Routes>
                <Route path="/" element={<OAuthLogin />} />
                <Route path="/login" element={<OAuthLogin />} />
                <Route path="/mistakes" element={<Mistakes />} />
                <Route path="/results" element={<Results />} />
                <Route path="/history" element={<HistoryRoute />} />
                <Route path="/scores" element={<ScoresRoute />} />
                <Route path="/all-correct" element={<AllCorrect />} />
                <Route path="/app/*" element={<App />} />
            </Routes>
        </BrowserRouter>
    </React.StrictMode>
)
