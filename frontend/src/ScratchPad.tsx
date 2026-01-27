import React, { useRef, useEffect } from 'react';

interface ScratchPadProps {
    visible: boolean;
    onClose: () => void;
}

const ScratchPad: React.FC<ScratchPadProps> = ({ visible, onClose }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawing = useRef(false);

    useEffect(() => {
        if (!visible && canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
            }
        }
    }, [visible]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#222';

        const getPos = (e: MouseEvent | TouchEvent) => {
            if ('touches' in e) {
                const t = e.touches[0];
                return { x: t.clientX - canvas.offsetLeft, y: t.clientY - canvas.offsetTop };
            } else {
                return { x: (e as MouseEvent).clientX - canvas.offsetLeft, y: (e as MouseEvent).clientY - canvas.offsetTop };
            }
        };

        const start = (e: MouseEvent | TouchEvent) => {
            drawing.current = true;
            const pos = getPos(e);
            ctx.beginPath();
            ctx.moveTo(pos.x, pos.y);
        };
        const move = (e: MouseEvent | TouchEvent) => {
            if (!drawing.current) return;
            const pos = getPos(e);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
        };
        const end = () => {
            drawing.current = false;
            ctx.closePath();
        };

        canvas.addEventListener('mousedown', start);
        canvas.addEventListener('mousemove', move);
        canvas.addEventListener('mouseup', end);
        canvas.addEventListener('mouseleave', end);
        canvas.addEventListener('touchstart', start);
        canvas.addEventListener('touchmove', move);
        canvas.addEventListener('touchend', end);
        canvas.addEventListener('touchcancel', end);

        return () => {
            canvas.removeEventListener('mousedown', start);
            canvas.removeEventListener('mousemove', move);
            canvas.removeEventListener('mouseup', end);
            canvas.removeEventListener('mouseleave', end);
            canvas.removeEventListener('touchstart', start);
            canvas.removeEventListener('touchmove', move);
            canvas.removeEventListener('touchend', end);
            canvas.removeEventListener('touchcancel', end);
        };
    }, [visible]);

    if (!visible) return null;
    return (
        <div style={{
            position: 'fixed',
            zIndex: 9999,
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(255, 200, 40, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.2s',
        }}>
            <canvas
                ref={canvasRef}
                width={window.innerWidth}
                height={window.innerHeight}
                style={{
                    width: '100vw',
                    height: '100vh',
                    touchAction: 'none',
                    background: 'transparent',
                }}
            />
            <button
                onClick={onClose}
                style={{
                    position: 'fixed',
                    top: 24,
                    right: 24,
                    zIndex: 10000,
                    background: '#fff8',
                    border: 'none',
                    borderRadius: '50%',
                    width: 48,
                    height: 48,
                    fontSize: 28,
                    cursor: 'pointer',
                }}
                aria-label="关闭写字板"
            >
                ✕
            </button>
        </div>
    );
};

export default ScratchPad;
