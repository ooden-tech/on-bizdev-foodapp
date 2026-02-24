import React from 'react';
import { FocusItem } from '@/utils/analytics-helpers';

// Inline SVGs replacing lucide-react
const AlertTriangle = ({ className = "" }: { className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
    </svg>
);

const Info = ({ className = "" }: { className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
    </svg>
);

interface FocusItemBannerProps {
    focusItem: FocusItem | null;
    onClick?: () => void;
}

export default function FocusItemBanner({ focusItem, onClick }: FocusItemBannerProps) {
    if (!focusItem) {
        return (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 mb-6 flex items-start">
                <div className="flex-shrink-0">
                    <Info className="h-5 w-5 text-emerald-400" aria-hidden="true" />
                </div>
                <div className="ml-3">
                    <h3 className="text-sm font-medium text-emerald-800">You're on track!</h3>
                    <div className="mt-2 text-sm text-emerald-700">
                        <p>All your tracked nutrients are close to their targets this week. Keep up the good work!</p>
                    </div>
                </div>
            </div>
        );
    }

    const { severity, message, nutrient } = focusItem;

    const bgClass = severity === 'high' ? 'bg-red-50' : 'bg-amber-50';
    const borderClass = severity === 'high' ? 'border-red-200' : 'border-amber-200';
    const textClass = severity === 'high' ? 'text-red-800' : 'text-amber-800';
    const iconClass = severity === 'high' ? 'text-red-400' : 'text-amber-400';

    return (
        <div
            onClick={onClick}
            className={`${bgClass} border ${borderClass} rounded-lg p-4 mb-6 flex items-start ${onClick ? 'cursor-pointer hover:shadow-sm transition-shadow' : ''}`}
        >
            <div className="flex-shrink-0 pt-0.5">
                <AlertTriangle className={`h-5 w-5 ${iconClass}`} aria-hidden="true" />
            </div>
            <div className="ml-3">
                <h3 className={`text-sm font-medium ${textClass}`}>Primary Focus Area</h3>
                <div className={`mt-1 text-sm ${textClass} opacity-90`}>
                    <p>{message}</p>
                </div>
                {onClick && (
                    <div className="mt-2">
                        <span className={`text-xs font-semibold ${textClass} underline`}>
                            View {nutrient.replace(/_/g, ' ')} details
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}
