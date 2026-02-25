import React, { useState } from 'react';
import { NutrientDisplay, UserGoal } from './NutrientDisplay';
import { formatNutrientName, formatNutrientValue } from '../../utils/formatting';

interface FoodItem {
    food_name: string;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_total_g: number;
    serving_size?: string;
    confidence?: 'low' | 'medium' | 'high';
    confidence_details?: Record<string, 'low' | 'medium' | 'high'>;
    error_sources?: string[];
    [key: string]: any;
}

interface FoodLogConfirmationProps {
    nutrition: FoodItem[];
    userGoals?: UserGoal[];
    onConfirm: () => void;
    onDecline: () => void;
    onEdit?: (items: FoodItem[]) => void; // Placeholder for future explicit edit UI
    title?: string;
    confirmLabel?: string;
}

const formatConfidenceReason = (reason: string): string => {
    const map: Record<string, string> = {
        'vague_portion': 'Portion size was unclear',
        'unknown_preparation': 'Preparation method unknown',
        'guesswork': 'Best guess based on description',
        'llm_estimation': 'AI estimated matching real food data',
        'calculated_from_macros': 'Calories calculated from macros',
        'fallback_used_invalid_cache': 'Cached data was invalid',
        'fallback_used_invalid_api': 'API returned invalid data',
        'fallback_used_no_api_data': 'No data found in database',
        'fallback_used_api_error': 'Database connection failed',
        'no_data': 'No exact match found'
    };
    return map[reason] || reason.replace(/_/g, ' ');
};

export const FoodLogConfirmation: React.FC<FoodLogConfirmationProps> = ({
    nutrition,
    userGoals = [],
    onConfirm,
    onDecline,
    onEdit,
    title = 'Verify log',
    confirmLabel = 'Log Food'
}) => {
    const [showDetails, setShowDetails] = useState(false);
    // 'totals' = aggregated view, 0..N = individual item index
    const [activeTab, setActiveTab] = useState<'totals' | number>('totals');
    const isMultiItem = nutrition.length > 1;

    const totalCalories = nutrition.reduce((sum, item) => sum + (item.calories || 0), 0);
    const mainItem = nutrition[0];
    // Combined natural name for multi-item, e.g. "Bread and Water"
    const itemName = isMultiItem
        ? nutrition.map(i => i.food_name).join(' and ')
        : (mainItem?.food_name || 'Food Item');

    // The item whose data to show in the details section
    const activeItem = typeof activeTab === 'number' ? nutrition[activeTab] : null;

    // Calculate totals for tracked nutrients in order
    const aggregated = nutrition.reduce((acc, item) => {
        Object.keys(item).forEach(key => {
            if (typeof item[key] === 'number') {
                acc[key] = (acc[key] || 0) + item[key];
            }
        });
        return acc;
    }, {} as any);

    // Data source: totals or individual item
    const displayData = activeItem || aggregated;
    const displayItem = activeItem || mainItem;

    const trackedDetails = userGoals
        .map(goal => {
            const val = displayData[goal.nutrient];
            // Show all tracked nutrients, default to 0 if not present
            return {
                key: goal.nutrient,
                name: formatNutrientName(goal.nutrient),
                valueStr: formatNutrientValue(goal.nutrient, val),
                unit: '', // unit is now included in valueStr
                confidence: displayItem?.confidence_details?.[goal.nutrient] || displayItem?.confidence || 'high'
            };
        })
        .sort((a, b) => {
            const priority = ['calories', 'protein_g', 'carbs_g', 'fat_total_g', 'water', 'fiber_g', 'sugar_g'];
            const idxA = priority.indexOf(a.key);
            const idxB = priority.indexOf(b.key);
            if (idxA !== -1 && idxB !== -1) return idxA - idxB;
            if (idxA !== -1) return -1;
            if (idxB !== -1) return 1;
            return 0;
        });

    return (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden mt-2">
            <div className="bg-blue-50 px-4 py-1.5 border-b border-blue-100">
                <span className="font-bold text-blue-900 text-xs uppercase tracking-tight">{title}</span>
            </div>

            <div className="p-4 space-y-3">
                {/* Header Section */}
                <div className="flex justify-between items-start gap-3">
                    {/* Left Column: Name & Portion */}
                    <div className="flex-1 min-w-0">
                        <h3 className="text-lg font-bold text-gray-900 leading-tight mb-0.5 break-words">
                            {itemName}
                        </h3>
                        <div className="text-sm text-gray-500 font-medium">
                            {isMultiItem
                                ? `${nutrition.length} items`
                                : (mainItem?.display_portion || mainItem?.serving_size || '1 serving')}
                        </div>
                    </div>

                    {/* Right Column: Calories & Badge */}
                    <div className="flex flex-col items-end flex-shrink-0">
                        <span className="text-xl font-black text-blue-600 whitespace-nowrap leading-none mb-1">
                            {Math.round(totalCalories)} <span className="text-sm font-bold text-blue-500">kcal</span>
                        </span>

                        {(!mainItem?.confidence || mainItem.confidence === 'medium' || mainItem.confidence === 'low') && (
                            <span
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${mainItem?.confidence === 'low' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                                    }`}
                                title={(mainItem?.error_sources?.length ?? 0) > 0 ? `Reasons: ${mainItem.error_sources!.map(formatConfidenceReason).join(', ')}` : undefined}
                            >
                                {mainItem?.confidence === 'low' ? 'Low Confidence' : 'Medium Confidence'}
                            </span>
                        )}
                        {(mainItem?.confidence === 'high') && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 whitespace-nowrap">
                                High Confidence
                            </span>
                        )}

                        {(mainItem?.error_sources?.length ?? 0) > 0 && (
                            <div className="mt-1 flex flex-col items-end">
                                {mainItem.error_sources!.map((reason, idx) => (
                                    <span
                                        key={idx}
                                        className="text-[10px] text-gray-400 text-right leading-tight max-w-[140px] truncate"
                                        title={formatConfidenceReason(reason)}
                                    >
                                        {formatConfidenceReason(reason)}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Item Slider Pills (multi-item only) */}
                {isMultiItem && (
                    <div className="flex gap-1.5 overflow-x-auto pt-1 pb-0.5">
                        <button
                            onClick={() => setActiveTab('totals')}
                            className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${activeTab === 'totals'
                                    ? 'bg-blue-600 text-white shadow-sm'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                        >
                            Totals
                        </button>
                        {nutrition.map((item, idx) => (
                            <button
                                key={idx}
                                onClick={() => setActiveTab(idx)}
                                className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${activeTab === idx
                                        ? 'bg-blue-600 text-white shadow-sm'
                                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                    }`}
                            >
                                {item.food_name}
                            </button>
                        ))}
                    </div>
                )}

                {/* Individual item info when a specific tab is selected */}
                {typeof activeTab === 'number' && activeItem && (
                    <div className="flex justify-between items-center text-sm bg-blue-50/60 px-3 py-1.5 rounded-md border border-blue-100">
                        <span className="font-semibold text-gray-700">{activeItem.food_name}</span>
                        <div className="flex items-center gap-3">
                            <span className="text-xs text-gray-500">{activeItem.display_portion || activeItem.serving_size || '1 serving'}</span>
                            <span className="font-mono font-bold text-blue-600">{Math.round(activeItem.calories)} kcal</span>
                        </div>
                    </div>
                )}

                {/* Tracking Details Toggle */}
                {trackedDetails.length > 0 && (
                    <div className="pt-1">
                        <button
                            onClick={() => setShowDetails(!showDetails)}
                            className="flex items-center text-xs font-bold text-gray-400 hover:text-blue-600 transition-colors py-1"
                        >
                            <span>Nutrition Details</span>
                            <svg
                                className={`ml-1 h-3 w-3 transform transition-transform duration-200 ${showDetails ? 'rotate-180' : ''}`}
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                        </button>

                        {showDetails && (
                            <div className="mt-1 space-y-1.5 bg-gray-50/80 p-3 rounded-md border border-gray-100 animate-in fade-in zoom-in-95 duration-200">
                                {trackedDetails.map((n: any, idx) => (
                                    <div key={idx} className="flex justify-between items-center text-xs">
                                        <div className="flex items-center gap-1.5">
                                            {/* Confidence Dot Indicator */}
                                            {n.confidence === 'low' && n.valueStr !== '0 g' && (
                                                <div className="w-1.5 h-1.5 rounded-full bg-red-400 ring-4 ring-red-50" title="Low confidence" />
                                            )}
                                            {n.confidence === 'medium' && n.valueStr !== '0 g' && (
                                                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 ring-4 ring-amber-50" title="Medium confidence" />
                                            )}
                                            {((n.confidence === 'high' || !n.confidence) || n.valueStr === '0 g') && (
                                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 ring-4 ring-emerald-50" title="High confidence" />
                                            )}
                                            <span className="font-semibold text-gray-600">{n.name}</span>
                                        </div>
                                        <span className={`font-mono font-bold ${(n.confidence === 'low' && n.valueStr !== '0 g') ? 'text-red-600' :
                                            (n.confidence === 'medium' && n.valueStr !== '0 g') ? 'text-amber-600' :
                                                'text-gray-800'
                                            }`}>
                                            {n.valueStr}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Actions */}
                <div className="flex gap-3 pt-2">
                    <button
                        onClick={onDecline}
                        className="flex-1 py-2 px-3 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        className="flex-1 py-2 px-3 bg-blue-600 border border-transparent text-white rounded-md text-sm font-bold hover:bg-blue-700 shadow-sm transition-colors"
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
};
