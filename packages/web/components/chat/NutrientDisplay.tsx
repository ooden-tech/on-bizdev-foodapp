import React, { useState } from 'react';
import { formatNutrientName, formatNutrientValue } from '../../utils/formatting';
import { MASTER_NUTRIENT_MAP } from 'shared';

export interface UserGoal {
    nutrient: string;
    target_value: number;
    unit: string;
    goal_type?: string;
}

export interface NutrientDisplayProps {
    nutrition: any[];
    userGoals?: UserGoal[];
    variant?: 'chat' | 'dashboard' | 'compact';
}

export const NutrientDisplay: React.FC<NutrientDisplayProps> = ({
    nutrition,
    userGoals = [],
    variant = 'chat'
}) => {
    const [showAll, setShowAll] = useState(false);

    if (!nutrition || nutrition.length === 0) return null;

    const coreKeys = ['protein_g', 'carbs_g', 'fat_total_g'];
    const trackedKeys = userGoals
        .map(g => g.nutrient)
        .filter(k => k !== 'calories' && MASTER_NUTRIENT_MAP[k]);

    return (
        <div className="space-y-2">
            {nutrition.map((item, i) => {
                const allKeys = Object.keys(item);
                const otherKeys = allKeys.filter(k =>
                    MASTER_NUTRIENT_MAP[k] &&
                    !coreKeys.includes(k) &&
                    !trackedKeys.includes(k) &&
                    k !== 'calories' &&
                    typeof item[k] === 'number' &&
                    item[k] > 0
                );

                const hasNutrientsToShow = coreKeys.some(k => typeof item[k] === 'number') ||
                    trackedKeys.some(k => typeof (item[k] !== undefined ? item[k] : (item.extras as any)?.[k]) === 'number');

                return (
                    <div key={i} className={`${variant === 'dashboard' ? '' : 'pb-2 mb-2 border-b border-gray-100 last:border-0 last:pb-0 last:mb-0'}`}>
                        {variant !== 'dashboard' && item.food_name && (
                            <div className="flex justify-between text-sm mb-1">
                                <span className="font-bold text-gray-800 truncate pr-2">{item.food_name}</span>
                                <span className="text-blue-600 font-black whitespace-nowrap">{Math.round(item.calories)} kcal</span>
                            </div>
                        )}

                        {/* Essential Macros + Tracked Goals */}
                        <div className={`flex flex-wrap gap-x-3 gap-y-1 ${variant === 'dashboard' ? 'text-[11px]' : 'text-[11px]'}`}>
                            {variant === 'dashboard' && typeof item.calories === 'number' && (
                                <span className="font-bold text-blue-600">{formatNutrientValue('calories', item.calories)}</span>
                            )}

                            {coreKeys.map(k => typeof item[k] === 'number' && (
                                <span key={k} className="text-gray-700">
                                    <span className="font-bold text-blue-700">{formatNutrientName(k)}</span> {formatNutrientValue(k, item[k])}
                                </span>
                            ))}

                            {trackedKeys.map(k => {
                                const val = item[k] !== undefined ? item[k] : (item.extras as any)?.[k];
                                if (typeof val === 'number' && val > 0) {
                                    return (
                                        <span key={k} className="text-gray-700">
                                            <span className="font-bold text-emerald-700">{formatNutrientName(k)}</span> {formatNutrientValue(k, val)}
                                        </span>
                                    );
                                }
                                return null;
                            })}
                        </div>

                        {/* Collapsable Menu for other nutrients */}
                        {otherKeys.length > 0 && (
                            <div className="mt-1">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setShowAll(!showAll);
                                    }}
                                    className="text-[10px] font-bold text-gray-400 hover:text-blue-500 flex items-center transition-colors focus:outline-none"
                                >
                                    {showAll ? 'Collapse' : `+ ${otherKeys.length} more nutrients`}
                                    <svg className={`ml-0.5 h-2.5 w-2.5 transform transition-transform ${showAll ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M19 9l-7 7-7-7" />
                                    </svg>
                                </button>
                                {showAll && (
                                    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 mt-1 bg-gray-50 p-1.5 rounded border border-gray-100 animate-in fade-in slide-in-from-top-1 duration-200">
                                        {otherKeys.map(k => (
                                            <div key={k} className="text-[10px] flex justify-between">
                                                <span className="text-gray-500">{formatNutrientName(k)}</span>
                                                <span className="font-medium text-gray-700">{formatNutrientValue(k, item[k])}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
