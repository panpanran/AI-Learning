import React from 'react';
import { useNavigate } from 'react-router-dom';

function AllCorrect() {
    const navigate = useNavigate();
    return (
        <div className="container" style={{ maxWidth: 480, margin: '40px auto', textAlign: 'center' }}>
            <div className="card p-4">
                <h2 className="mb-4">全部答对！</h2>
                <p className="mb-4">恭喜你，本轮题目全部正确！</p>
                <div className="d-grid gap-2">
                    <button className="btn btn-primary mb-2" onClick={() => navigate('/app')}>继续做题</button>
                    <button className="btn btn-secondary" onClick={() => navigate('/')}>选课程</button>
                </div>
            </div>
        </div>
    );
}

export default AllCorrect;
