import React, { useState } from 'react';
import { UserGoal } from './NutrientDisplay';
import { MASTER_NUTRIENT_MAP } from 'shared';

interface Ingredient {
    name: string;
    amount: string;
    unit: string;
    calories?: number;
}

interface RecipeData {
    recipe_name: string;
    servings: number;
    ingredients: Ingredient[];
    nutrition_data?: {
        calories: number;
        confidence?: 'low' | 'medium' | 'high';
        confidence_details?: Record<string, 'low' | 'medium' | 'high'>;
        [key: string]: any;
    };
}

interface RecipeConfirmationProps {
    recipe: RecipeData;
    userGoals?: UserGoal[];
    preview?: string;
    isMatch?: boolean;
    existingRecipeName?: string;
    onConfirm: (choice?: string, portion?: string, name?: string) => void;
    onDecline: () => void;
}

export const RecipeConfirmation: React.FC<RecipeConfirmationProps> = ({
    recipe,
    userGoals = [],
    preview,
    isMatch,
    existingRecipeName,
    onConfirm,
    onDecline
}) => {
    const [portion, setPortion] = React.useState("1 serving");
    const [recipeName, setRecipeName] = React.useState(recipe.recipe_name);
    const [showIngredients, setShowIngredients] = React.useState(true);
    const nutrition = recipe.nutrition_data;

    // Calculate tracked nutrients (scaled to 1 serving if isMatch, otherwise total)
    const trackedDetails = userGoals
        .filter(goal => goal?.nutrient && goal.nutrient !== 'calories')
        .map(goal => {
            let val = nutrition ? nutrition[goal.nutrient] : undefined;

            // If it's a save recipe flow, usually we look at per-serving or total.
            const divisor = (isMatch || !recipe.servings) ? (recipe.servings || 1) : 1;
            const scaledVal = typeof val === 'number' ? val / divisor : 0;

            // Get confidence for this nutrient
            const conf = nutrition?.confidence_details?.[goal.nutrient] || nutrition?.confidence || 'high';

            return {
                name: MASTER_NUTRIENT_MAP[goal.nutrient]?.name || goal.nutrient.replace(/_/g, ' '),
                value: scaledVal,
                unit: MASTER_NUTRIENT_MAP[goal.nutrient]?.unit || goal.unit,
                confidence: conf
            };
        });

    const displayCalories = nutrition ? (nutrition.calories / (isMatch ? (recipe.servings || 1) : 1)) : 0;

    return (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden mt-2">
            {/* Status Header */}
            <div className={`${isMatch ? 'bg-amber-50' : 'bg-emerald-50'} px-4 py-1.5 border-b ${isMatch ? 'border-amber-100' : 'border-emerald-100'} flex justify-between items-center`}>
                <span className={`font-bold ${isMatch ? 'text-amber-900' : 'text-emerald-900'} text-[10px] uppercase tracking-wider`}>
                    {isMatch ? `Existing Match: ${existingRecipeName || 'Found'}` : 'Save New Recipe'}
                </span>
            </div>

            <div className="p-4 space-y-4">
                {/* Header Row: Name | Calories */}
                <div className="flex justify-between items-start">
                    <div className="flex-1 min-w-0 pr-4">
                        <input
                            type="text"
                            value={recipeName}
                            onChange={(e) => setRecipeName(e.target.value)}
                            className="w-full text-lg font-bold text-gray-900 bg-transparent border-b border-dashed border-gray-300 focus:border-emerald-500 focus:outline-none"
                            placeholder="Recipe Name"
                        />
                        <div className="flex items-center gap-2 mt-1">
                            <p className="text-xs text-gray-500">
                                {recipe.servings} Servings total • {isMatch ? 'Showing 1 serving' : 'Showing total batch'}
                            </p>
                            {/* Confidence Tag */}
                            {nutrition?.confidence && nutrition.confidence !== 'high' && (
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${nutrition.confidence === 'low' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                                    {nutrition.confidence === 'low' ? 'Low Confidence' : 'Medium Confidence'}
                                </span>
                            )}
                            {(!nutrition?.confidence || nutrition.confidence === 'high') && (
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
                                    High Confidence
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="text-lg font-black text-emerald-600 whitespace-nowrap">
                            {Math.round(displayCalories)} kcal
                        </div>
                    </div>
                </div>

                {/* Portion Input if Match */}
                {isMatch && (
                    <div className="bg-amber-50/50 border border-amber-100 rounded p-2.5">
                        <label className="text-[10px] font-bold text-amber-700 uppercase tracking-widest block mb-1">Logging Portion</label>
                        <input
                            type="text"
                            value={portion}
                            onChange={(e) => setPortion(e.target.value)}
                            placeholder="e.g. 1 serving"
                            className="w-full text-sm bg-white border border-amber-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-500 font-medium"
                        />
                    </div>
                )}

                {/* Split Menu: Ingredients | Nutrients */}
                <div className="grid grid-cols-2 gap-4 pt-2 border-t border-gray-100">
                    {/* Left: Ingredients */}
                    <div className="space-y-2">
                        <button
                            onClick={() => setShowIngredients(!showIngredients)}
                            className="flex items-center gap-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest hover:text-gray-600"
                        >
                            <span>Ingredients</span>
                            <span className={`text-[8px] transform transition-transform ${showIngredients ? 'rotate-90' : ''}`}>▶</span>
                        </button>
                        {showIngredients && (
                            <div className="max-h-48 overflow-y-auto space-y-1.5 pr-2 custom-scrollbar">
                                {recipe.ingredients?.map((ing, idx) => (
                                    <div key={idx} className="flex flex-col border-b border-gray-50 pb-1 last:border-0">
                                        <span className="text-xs font-medium text-gray-700 leading-tight">{ing.name}</span>
                                        <span className="text-[10px] text-gray-500 italic">{ing.amount} {ing.unit}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Right: Tracked Nutrients */}
                    <div className="space-y-2 border-l border-gray-100 pl-4">
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block">Tracked Goals</span>
                        <div className="space-y-2">
                            {trackedDetails.length > 0 ? (
                                trackedDetails.map((n: any, idx) => (
                                    <div key={idx} className="flex flex-col border-b border-gray-50 pb-1 last:border-0">
                                        <div className="flex items-center gap-1">
                                            <span className="text-[10px] font-medium text-gray-500 uppercase tracking-tight">{n.name}</span>
                                            {n.confidence === 'low' && <span className="w-1.5 h-1.5 rounded-full bg-red-400" title="Low confidence"></span>}
                                            {n.confidence === 'medium' && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" title="Medium confidence"></span>}
                                            {(n.confidence === 'high' || !n.confidence) && <span className="w-1.5 h-1.5 rounded-full bg-green-400" title="High confidence"></span>}
                                        </div>
                                        <span className={`text-xs font-bold ${n.confidence === 'low' ? 'text-red-700' : n.confidence === 'medium' ? 'text-amber-700' : 'text-gray-800'}`}>
                                            {Math.round(n.value * 10) / 10}{n.unit}
                                        </span>
                                    </div>
                                ))
                            ) : (
                                <p className="text-[10px] text-gray-400 italic">No additional goals tracked.</p>
                            )}
                        </div>
                    </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 pt-2">
                    {isMatch ? (
                        <>
                            <button
                                onClick={() => onConfirm("log", portion, recipeName)}
                                className="w-full py-2.5 px-3 bg-amber-600 border border-transparent text-white rounded-md text-sm font-bold hover:bg-amber-700 shadow-sm transition-colors flex items-center justify-center gap-2"
                            >
                                🍽️ Log Portion
                            </button>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => onConfirm("update", portion, recipeName)}
                                    className="flex-1 py-1.5 px-3 bg-white border border-gray-300 text-gray-700 rounded-md text-xs font-semibold hover:bg-gray-50 transition-colors"
                                >
                                    Edit and Log
                                </button>
                                <button
                                    onClick={() => onConfirm("new", undefined, recipeName)}
                                    className="flex-1 py-1.5 px-3 bg-white border border-gray-300 text-gray-700 rounded-md text-xs font-semibold hover:bg-gray-50 transition-colors"
                                >
                                    Save as New
                                </button>
                            </div>
                            <button
                                onClick={onDecline}
                                className="w-full py-1 text-gray-400 text-[10px] font-medium hover:text-gray-600 transition-colors"
                            >
                                Cancel
                            </button>
                        </>
                    ) : (
                        <div className="flex gap-3">
                            <button
                                onClick={onDecline}
                                className="flex-1 py-2 px-3 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => onConfirm(undefined, undefined, recipeName)}
                                className="flex-1 py-2 px-3 bg-emerald-600 border border-transparent text-white rounded-md text-sm font-bold hover:bg-emerald-700 shadow-sm transition-colors"
                            >
                                Save Recipe
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
