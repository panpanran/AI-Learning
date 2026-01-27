import React from 'react'
import { useLocation } from 'react-router-dom'

function Mistakes() {
    const location = useLocation()
    const { answers, questions } = location.state || {}
    if (!answers || !questions) return <div>No mistakes found.</div>

    // 找出错题
    const wrongs = answers.filter((a: any) => !a.correct)

    return (
        <div className="mistakes-root">
            <h2>错题解析</h2>
            {wrongs.length === 0 ? <div>全部答对！</div> : wrongs.map((a: any, idx: number) => (
                <div key={a.questionId} className="card" style={{ marginBottom: 16 }}>
                    <div><strong>题目：</strong> {a.prompt}</div>
                    <div><strong>你的答案：</strong> {a.answer}</div>
                    <div><strong>正确答案：</strong> {a.correctAnswer}</div>
                    <div><strong>解析：</strong> {a.explanation}</div>
                    <button className="btn">再练一次</button>
                </div>
            ))}
        </div>
    )
}

export default Mistakes
