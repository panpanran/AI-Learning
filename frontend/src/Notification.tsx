// Bootstrap-like notification component for React
import React from 'react';

type NotificationProps = {
    show: boolean;
    message: string;
    type?: 'danger' | 'success' | 'warning' | 'info';
    onClose?: () => void;
    placement?: 'inline' | 'toast';
};

export default function Notification({ show, message, type = 'danger', onClose, placement = 'inline' }: NotificationProps) {
    if (!show) return null;

    const toastStyle = placement === 'toast'
        ? ({ position: 'fixed', top: 24, right: 24, zIndex: 9999, minWidth: 240, boxShadow: '0 2px 8px #0002' } as React.CSSProperties)
        : undefined;

    return (
        <div className={`alert alert-${type} fade show`} style={toastStyle} role="alert">
            {message}
            {onClose && (
                <button type="button" className="btn-close" aria-label="Close" onClick={onClose}>
                    &times;
                </button>
            )}
        </div>
    );
}
