'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { formatWeight, formatVolume, formatMilligram, formatMicrogram, formatEnergy } from '@/utils/formatting';
import DashboardShell from '@/components/DashboardShell';

// Define Loading Spinner locally
const LoadingSpinner = () => {
  return (
    <div className="flex justify-center items-center py-2">
      <div className="relative w-6 h-6">
        <div className="absolute top-0 left-0 right-0 bottom-0 border-2 border-blue-100 rounded-full"></div>
        <div className="absolute top-0 left-0 right-0 bottom-0 border-2 border-transparent border-t-blue-600 rounded-full animate-spin"></div>
      </div>
    </div>
  );
};

interface Ingredient {
  ingredient_name: string;
  quantity: number;
  unit: string;
  nutrition_data?: Record<string, number>;
}

interface SavedRecipe {
  id: string;
  recipe_name: string;
  calories?: number | null;
  description?: string | null;
  ingredients?: string | null;
  recipe_ingredients?: Ingredient[];
  per_serving_nutrition?: Record<string, number | null>;
  nutrition_data?: Record<string, number | null>;
  servings?: number;
  instructions?: string | null;
  [key: string]: unknown;
}

interface UserGoal {
  nutrient: string;
  target_value: number;
  unit: string;
}

export default function SavedRecipesPage() {
  const { user, supabase } = useAuth();
  const [recipes, setRecipes] = useState<SavedRecipe[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [loggingRecipeId, setLoggingRecipeId] = useState<string | null>(null);
  const [deletingRecipeId, setDeletingRecipeId] = useState<string | null>(null);
  const [isRecipeModalVisible, setIsRecipeModalVisible] = useState(false);
  const [isAddRecipeModalVisible, setIsAddRecipeModalVisible] = useState(false);
  const [selectedRecipeData, setSelectedRecipeData] = useState<SavedRecipe | null>(null);
  const [isModalLoading, setIsModalLoading] = useState(false);
  const [isSavingRecipe, setIsSavingRecipe] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [userGoals, setUserGoals] = useState<UserGoal[]>([]);

  const [portionModalRecipe, setPortionModalRecipe] = useState<SavedRecipe | null>(null);
  const [portionSize, setPortionSize] = useState('1 serving');

  const [newRecipe, setNewRecipe] = useState({
    name: '',
    description: '',
    servings: '1',
    ingredients: ''
  });

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);

  const loadData = useCallback(async (isRefreshing = false) => {
    if (!user || !supabase) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (!isRefreshing) setLoading(true);
    else setRefreshing(true);
    setError(null);
    setModalError(null);

    try {
      const [recipeResponse, goalsResponse] = await Promise.all([
        supabase
          .from('user_recipes')
          .select('*, recipe_ingredients(*)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('user_goals')
          .select('nutrient, target_value, unit')
          .eq('user_id', user.id)
      ]);

      if (recipeResponse.error) throw recipeResponse.error;
      setRecipes(recipeResponse.data || []);

      if (goalsResponse.error) {
        console.warn("Could not load user goals:", goalsResponse.error.message);
        setUserGoals([]);
      } else {
        setUserGoals(goalsResponse.data || []);
      }

    } catch (err: unknown) {
      console.error("Error loading data:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage || "Failed to load data.");
      setRecipes([]);
      setUserGoals([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, supabase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = () => {
    if (loggingRecipeId || deletingRecipeId) return;
    loadData(true);
  };

  const handleRecipeItemPress = (recipe: SavedRecipe) => {
    if (deletingRecipeId || loggingRecipeId) return;
    console.log("Opening modal for:", recipe.recipe_name);
    setSelectedRecipeData({ ...recipe });
    setIsRecipeModalVisible(true);
    setModalError(null);
  };

  const handleCloseModal = () => {
    setIsRecipeModalVisible(false);
    setSelectedRecipeData(null);
    setModalError(null);
    setIsEditing(false);
  };

  const handleStartEditing = () => {
    if (!selectedRecipeData) return;
    setEditName(selectedRecipeData.recipe_name);
    setEditInstructions(selectedRecipeData.instructions || '');
    setIsEditing(true);
  };

  const handleSaveChanges = async () => {
    if (!selectedRecipeData || !supabase || !user) return;
    if (!editName.trim()) {
      setModalError("Recipe name cannot be empty.");
      return;
    }

    setIsUpdating(true);
    setModalError(null);

    try {
      const { error: updateError } = await supabase
        .from('user_recipes')
        .update({
          recipe_name: editName.trim(),
          instructions: editInstructions.trim()
        })
        .eq('id', selectedRecipeData.id)
        .eq('user_id', user.id);

      if (updateError) throw updateError;

      const updatedRecipe = {
        ...selectedRecipeData,
        recipe_name: editName.trim(),
        instructions: editInstructions.trim()
      };
      setSelectedRecipeData(updatedRecipe);
      setRecipes(prev => prev.map(r => r.id === updatedRecipe.id ? updatedRecipe : r));
      setIsEditing(false);
    } catch (err: unknown) {
      console.error("Error updating recipe:", err);
      setModalError("Failed to save changes. Please try again.");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleLogRecipe = (recipeId: string, recipeName: string) => {
    if (loggingRecipeId || deletingRecipeId) return;
    const recipe = recipes.find(r => r.id === recipeId);
    if (recipe) {
      setPortionModalRecipe(recipe);
      setPortionSize('1 serving');
      setModalError(null);
    }
  };

  const handleConfirmLogRecipe = async () => {
    if (!portionModalRecipe || !supabase || !user) {
      alert("Authentication error. Cannot log recipe.");
      return;
    }

    console.log(`Logging recipe with portion: ${portionSize} of ${portionModalRecipe.recipe_name}`);
    setLoggingRecipeId(portionModalRecipe.id);
    setModalError(null);

    try {
      const { data: response, error: funcError } = await supabase.functions.invoke('chat-handler', {
        body: {
          message: `Log ${portionSize} of my recipe: ${portionModalRecipe.recipe_name}`,
        }
      });

      if (funcError) throw funcError;

      if (response.status === 'success') {
        alert(`Successfully logged ${portionSize} of ${portionModalRecipe.recipe_name}!`);
        setPortionModalRecipe(null);
        handleCloseModal();
      } else {
        throw new Error(response.message || 'Failed to log recipe');
      }
    } catch (err: unknown) {
      console.error("Failed to log recipe via function:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setModalError(`Failed to log recipe: ${errorMessage}`);
    } finally {
      setLoggingRecipeId(null);
    }
  };

  const handleDeleteRecipe = async (recipeId: string, recipeName: string) => {
    if (deletingRecipeId || loggingRecipeId) return;

    if (!window.confirm(`Are you sure you want to delete the recipe "${recipeName}"? This cannot be undone.`)) {
      return;
    }
    console.log(`Attempting to delete recipe: ${recipeName} (${recipeId})`);
    setDeletingRecipeId(recipeId);
    setModalError(null);

    if (!supabase || !user) {
      setModalError("Authentication error. Cannot delete recipe.");
      setDeletingRecipeId(null);
      return;
    }

    try {
      const { error } = await supabase
        .from('user_recipes')
        .delete()
        .match({ id: recipeId, user_id: user.id });

      if (error) {
        throw error;
      }

      console.log("Recipe deleted successfully from DB.");
      setRecipes(prev => prev.filter(recipe => recipe.id !== recipeId));
      handleCloseModal();
      alert(`Recipe "${recipeName}" deleted.`);
    } catch (err: unknown) {
      console.error("Failed to delete recipe:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setModalError(`Failed to delete recipe: ${errorMessage}`);
    } finally {
      setDeletingRecipeId(null);
    }
  };

  const handleSaveNewRecipe = async () => {
    if (!newRecipe.name || !newRecipe.ingredients || !supabase) {
      setModalError(supabase ? "Recipe name and ingredients are required." : "Authentication error. Please try logging in again.");
      return;
    }

    setIsSavingRecipe(true);
    setModalError(null);

    try {
      const { data: response, error: funcError } = await supabase.functions.invoke('chat-handler', {
        body: {
          message: `Save my recipe: ${newRecipe.name}. Servings: ${newRecipe.servings}. Ingredients: ${newRecipe.ingredients}`
        }
      });

      if (funcError) throw funcError;

      if (response.status === 'success') {
        setIsAddRecipeModalVisible(false);
        setNewRecipe({ name: '', description: '', servings: '1', ingredients: '' });
        loadData(true);
      } else {
        throw new Error(response.message || 'Failed to save recipe');
      }
    } catch (err: unknown) {
      console.error("Failed to save recipe:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setModalError(`Failed to save recipe: ${errorMessage}`);
    } finally {
      setIsSavingRecipe(false);
    }
  };

  const renderRecipeModal = () => {
    if (!isRecipeModalVisible || !selectedRecipeData) return null;

    const formatValue = (value: number | null | undefined, unit: string): string => {
      if (value === null || value === undefined || isNaN(value)) return '-';
      switch (unit?.toLowerCase()) {
        case 'g': return formatWeight(value);
        case 'mg': return formatMilligram(value);
        case 'mcg':
        case 'μg': return formatMicrogram(value);
        case 'ml': return formatVolume(value);
        case 'kcal': return formatEnergy(value);
        default: return `${value.toFixed(0)} ${unit || ''}`;
      }
    };

    const NUTRIENT_MAP: Record<string, { name: string; unit: string }> = {
      protein_g: { name: "Protein", unit: "g" },
      fat_total_g: { name: "Total Fat", unit: "g" },
      carbs_g: { name: "Carbohydrates", unit: "g" },
      calories: { name: "Calories", unit: "kcal" },
      hydration_ml: { name: "Water", unit: "ml" },
      fiber_g: { name: "Fiber", unit: "g" },
      sugar_g: { name: "Sugar", unit: "g" },
      sodium_mg: { name: "Sodium", unit: "mg" },
      potassium_mg: { name: "Potassium", unit: "mg" },
      calcium_mg: { name: "Calcium", unit: "mg" },
      iron_mg: { name: "Iron", unit: "mg" },
      magnesium_mg: { name: "Magnesium", unit: "mg" },
    };

    const perServingNutrition = selectedRecipeData.per_serving_nutrition || (selectedRecipeData.nutrition_data ? (
      Object.fromEntries(
        Object.entries(selectedRecipeData.nutrition_data).map(([k, v]) => [k, typeof v === 'number' ? v / (selectedRecipeData.servings || 1) : v])
      )
    ) : {});

    const trackedDetails = userGoals
      .filter(goal => goal.nutrient !== 'calories')
      .map(goal => {
        const key = goal.nutrient;
        const value = perServingNutrition[key] ?? (selectedRecipeData[key] !== undefined ? (selectedRecipeData[key] as number / (selectedRecipeData.servings || 1)) : 0);
        const mapping = NUTRIENT_MAP[key];

        return {
          key,
          name: mapping?.name || key.replace(/_/g, ' '),
          value: typeof value === 'number' ? value : 0,
          unit: mapping?.unit || goal.unit
        };
      });

    const displayCalories = perServingNutrition.calories ?? (typeof selectedRecipeData.calories === 'number' ? (selectedRecipeData.calories / (selectedRecipeData.servings || 1)) : 0);

    return (
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-center items-center p-4 transition-all animate-in fade-in duration-200">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden border border-gray-100">
          {/* Modal Header */}
          <div className="bg-emerald-50 px-4 py-2 border-b border-emerald-100 flex justify-between items-center">
            <span className="font-bold text-emerald-900 text-[10px] uppercase tracking-wider">Recipe Details</span>
            <button
              onClick={handleCloseModal}
              className="text-emerald-400 hover:text-emerald-600 p-1 rounded-full transition-colors"
              aria-label="Close modal"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="p-5 flex justify-between items-start">
            <div className="flex-1 min-w-0 pr-4">
              {isEditing ? (
                <div className="space-y-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Recipe Name</label>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="text-xl font-bold text-gray-900 leading-tight w-full outline-none border-b-2 border-emerald-500 bg-emerald-50/30 px-1 py-0.5 rounded-t"
                      placeholder="Recipe name"
                      autoFocus
                    />
                  </div>
                </div>
              ) : (
                <div className="group flex items-center gap-2">
                  <h3 className="text-xl font-bold text-gray-900 leading-tight">
                    {selectedRecipeData.recipe_name}
                  </h3>
                  <button
                    onClick={handleStartEditing}
                    className="p-1 text-gray-300 hover:text-emerald-500 transition-colors opacity-0 group-hover:opacity-100"
                    title="Edit Name"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                    </svg>
                  </button>
                </div>
              )}
              <p className="text-sm text-gray-500 mt-1 font-medium">
                {selectedRecipeData.servings || 1} Servings
                {selectedRecipeData.serving_size ? ` • ${selectedRecipeData.serving_size} per serving` : ''}
              </p>
            </div>
            {!isEditing && (
              <div className="text-right">
                <div className="text-2xl font-black text-emerald-600 whitespace-nowrap tracking-tight">
                  {formatEnergy(displayCalories as number)}
                </div>
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-0.5">PER SERVING</div>
              </div>
            )}
          </div>

          {/* Modal Body (Scrollable) */}
          <div className="px-5 pb-5 overflow-y-auto flex-1 custom-scrollbar">
            {/* Description */}
            {!isEditing && selectedRecipeData.description && (
              <div className="mb-6">
                <p className="text-sm text-gray-600 leading-relaxed italic border-l-2 border-emerald-100 pl-3">
                  {selectedRecipeData.description}
                </p>
              </div>
            )}

            <div className={`grid ${isEditing ? 'grid-cols-1' : 'grid-cols-2'} gap-6`}>
              {/* Left: Ingredients */}
              {!isEditing && (
                <div className="space-y-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Ingredients</span>
                  </div>
                  <div className="space-y-2">
                    {selectedRecipeData.recipe_ingredients && selectedRecipeData.recipe_ingredients.length > 0 ? (
                      selectedRecipeData.recipe_ingredients.map((ing, idx) => (
                        <div key={idx} className="flex flex-col border-b border-gray-50 pb-1.5 last:border-0">
                          <span className="text-xs font-bold text-gray-800 leading-tight">{ing.ingredient_name}</span>
                          <span className="text-[10px] text-gray-500 font-medium">{ing.quantity} {ing.unit}</span>
                        </div>
                      ))
                    ) : selectedRecipeData.ingredients ? (
                      <div className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">
                        {selectedRecipeData.ingredients}
                      </div>
                    ) : (
                      <p className="text-[10px] text-gray-400 italic">No ingredients listed.</p>
                    )}
                  </div>
                </div>
              )}

              {/* Right/Only: Tracked Nutrients / Edit View */}
              <div className={`space-y-3 ${!isEditing ? 'border-l border-gray-100 pl-6' : ''}`}>
                {!isEditing ? (
                  <>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none">Nutrition</span>
                      <span className="text-[8px] font-bold text-gray-300 uppercase tracking-tighter leading-none">Per Portion</span>
                    </div>
                    <div className="space-y-2.5">
                      {trackedDetails.length > 0 ? (
                        trackedDetails.map((n) => (
                          <div key={n.key} className="flex flex-col border-b border-gray-50 pb-1.5 last:border-0">
                            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-tight">{n.name}</span>
                            <span className="text-xs font-black text-gray-800">{formatValue(n.value, n.unit)}</span>
                          </div>
                        ))
                      ) : (
                        <p className="text-[10px] text-gray-400 italic">No goals tracked for this period.</p>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Instructions</label>
                      <textarea
                        value={editInstructions}
                        onChange={(e) => setEditInstructions(e.target.value)}
                        className="text-sm text-gray-700 leading-relaxed w-full outline-none border-2 border-emerald-100 focus:border-emerald-500 bg-white p-3 rounded-lg min-h-[150px] resize-none custom-scrollbar shadow-inner"
                        placeholder="Enter recipe instructions here... (Leave empty to hide)"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Instructions (View Mode) */}
            {!isEditing && selectedRecipeData.instructions && (
              <div className="mt-8 pt-6 border-t border-gray-100">
                <div className="flex items-center justify-between gap-1.5 mb-3">
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Instructions</span>
                  <button
                    onClick={handleStartEditing}
                    className="text-[10px] font-bold text-emerald-600 hover:text-emerald-700 uppercase tracking-wider transition-colors"
                  >
                    Edit
                  </button>
                </div>
                <div className="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed bg-gray-50/50 p-4 rounded-lg border border-gray-100 shadow-sm">
                  {selectedRecipeData.instructions}
                </div>
              </div>
            )}

            {!isEditing && !selectedRecipeData.instructions && (
              <div className="mt-8 pt-6 border-t border-gray-50 text-center">
                <button
                  onClick={handleStartEditing}
                  className="px-4 py-2 text-[10px] font-bold text-gray-400 hover:text-emerald-600 uppercase tracking-widest transition-all hover:bg-emerald-50 rounded-lg flex items-center justify-center gap-2 mx-auto border border-dashed border-gray-200"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
                  </svg>
                  Add Instructions
                </button>
              </div>
            )}

            {/* Modal Specific Error Display */}
            {modalError && (
              <div className="mt-6 bg-red-50 border border-red-100 rounded-lg p-3 flex items-center gap-3">
                <div className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse flex-shrink-0" />
                <p className="text-xs font-semibold text-red-600">{modalError}</p>
              </div>
            )}
          </div>

          {/* Modal Footer */}
          <div className="p-4 bg-gray-50/50 border-t border-gray-100 flex gap-3">
            {isEditing ? (
              <>
                <button
                  onClick={() => setIsEditing(false)}
                  disabled={isUpdating}
                  className="flex-1 py-2.5 px-4 bg-white border border-gray-200 text-gray-600 text-sm font-bold rounded-lg hover:bg-gray-50 transition-all shadow-sm active:scale-[0.98] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveChanges}
                  disabled={isUpdating}
                  className="flex-1 py-2.5 px-4 bg-emerald-600 text-white text-sm font-bold rounded-lg hover:bg-emerald-700 transition-all shadow-sm active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isUpdating ? 'Saving...' : 'Save Changes'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => handleDeleteRecipe(selectedRecipeData.id, selectedRecipeData.recipe_name)}
                  disabled={!!loggingRecipeId || !!deletingRecipeId}
                  className="flex-1 py-2.5 px-4 bg-white border border-red-200 text-red-600 text-sm font-bold rounded-lg hover:bg-red-50 hover:border-red-300 transition-all shadow-sm active:scale-[0.98] disabled:opacity-50"
                >
                  {deletingRecipeId === selectedRecipeData.id ? 'Deleting...' : 'Delete Recipe'}
                </button>

                <button
                  onClick={() => handleLogRecipe(selectedRecipeData.id, selectedRecipeData.recipe_name)}
                  disabled={!!loggingRecipeId || !!deletingRecipeId}
                  className="flex-1 py-2.5 px-4 bg-emerald-600 text-white text-sm font-bold rounded-lg hover:bg-emerald-700 transition-all shadow-sm active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loggingRecipeId === selectedRecipeData.id ? 'Logging...' : 'Log Recipe'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  const addRecipeButton = (
    <button
      onClick={() => setIsAddRecipeModalVisible(true)}
      className="p-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
      title="Add New Recipe"
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
    </button>
  );

  return (
    <DashboardShell headerTitle="Saved Recipes" headerRight={addRecipeButton}>
      {/* Error message */}
      {error && (
        <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-md border border-red-300">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && !refreshing ? (
        <div className="text-center py-20">
          <p className="text-gray-500">Loading recipes...</p>
        </div>
      ) : (
        <div>
          {/* Refreshing indicator */}
          {refreshing && (
            <div className="flex justify-center py-2 mb-4">
              <p>Refreshing...</p>
            </div>
          )}

          {/* Recipe list container */}
          {recipes.length > 0 ? (
            <div className="max-w-3xl mx-auto space-y-3">
              {recipes.map(recipe => (
                <div
                  key={recipe.id}
                  onClick={() => handleRecipeItemPress(recipe)}
                  className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden cursor-pointer hover:shadow-md transition-shadow duration-150 ease-in-out"
                >
                  <div className="px-5 py-4 flex justify-between items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-lg text-gray-900 truncate">{recipe.recipe_name}</h3>
                    </div>
                    <div className="flex items-center flex-shrink-0 ml-4">
                      {recipe.calories !== null && recipe.calories !== undefined && (
                        <span className="hidden sm:inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 mr-3">
                          {Math.round(recipe.calories)} kcal
                        </span>
                      )}
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : recipes.length === 0 ? (
            <div className="text-center py-10 px-4 bg-white rounded-lg border border-gray-200 shadow-sm">
              <p className="text-gray-600 mb-4">You haven&apos;t saved any recipes yet.</p>
              <Link href="/chat" className="text-blue-600 hover:underline">Start chatting to find and save recipes!</Link>
            </div>
          ) : (
            <div className="text-center py-10">
              <p className="text-lg text-gray-500">You haven't saved any recipes yet.</p>
              <p className="mt-2 text-gray-500">Recipes you save from the Chat will appear here.</p>
            </div>
          )}

          {/* Refresh Button */}
          {!loading && (
            <div className="flex justify-center mt-6 mb-4">
              <button
                onClick={handleRefresh}
                disabled={refreshing || loading || !!loggingRecipeId || !!deletingRecipeId}
                className={`px-4 py-2 border border-gray-300 rounded-md text-sm font-medium ${refreshing || loading || loggingRecipeId || deletingRecipeId ? 'opacity-50 cursor-not-allowed bg-gray-100' : 'text-gray-700 bg-white hover:bg-gray-50'}`}
              >
                {refreshing ? 'Refreshing...' : 'Refresh Recipes'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Render the recipe detail modal */}
      {renderRecipeModal()}

      {/* Add Recipe Modal */}
      {isAddRecipeModalVisible && (
        <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-5 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-xl font-semibold text-gray-800">Add New Recipe</h3>
              <button onClick={() => setIsAddRecipeModalVisible(false)} className="text-gray-400 hover:text-gray-600">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Recipe Name</label>
                <input
                  type="text"
                  value={newRecipe.name}
                  onChange={(e) => setNewRecipe({ ...newRecipe, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-black"
                  placeholder="e.g. Grandma's Chicken Soup"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Servings</label>
                  <input
                    type="number"
                    value={newRecipe.servings}
                    onChange={(e) => setNewRecipe({ ...newRecipe, servings: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-black"
                    min="1"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ingredients (one per line)</label>
                <textarea
                  value={newRecipe.ingredients}
                  onChange={(e) => setNewRecipe({ ...newRecipe, ingredients: e.target.value })}
                  rows={6}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-black"
                  placeholder={"e.g. 500g Chicken breast\n2 large carrots\n1 onion"}
                />
              </div>
              {modalError && <p className="text-sm text-red-600 bg-red-50 p-2 rounded">{modalError}</p>}
            </div>
            <div className="p-4 border-t border-gray-200 bg-gray-50 flex justify-end space-x-3">
              <button
                onClick={() => setIsAddRecipeModalVisible(false)}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
                disabled={isSavingRecipe}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveNewRecipe}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:bg-blue-300"
                disabled={isSavingRecipe}
              >
                {isSavingRecipe ? 'Saving...' : 'Save Recipe'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Portion Size Modal */}
      {portionModalRecipe && (
        <div className="fixed inset-0 bg-black bg-opacity-60 z-[60] flex justify-center items-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full overflow-hidden">
            <div className="p-5 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-800">Log Recipe Portion</h3>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-gray-600">
                How much of <strong className="text-gray-900">{portionModalRecipe.recipe_name}</strong> did you eat?
              </p>
              <input
                type="text"
                value={portionSize}
                onChange={(e) => setPortionSize(e.target.value)}
                placeholder="e.g. 1 serving, 2 cups, half, 300g"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-black"
              />
              {modalError && (
                <p className="text-sm text-red-600 bg-red-50 p-2 rounded">{modalError}</p>
              )}
            </div>
            <div className="p-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-3">
              <button
                onClick={() => setPortionModalRecipe(null)}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
                disabled={!!loggingRecipeId}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmLogRecipe}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:bg-blue-300 flex items-center"
                disabled={!!loggingRecipeId || !portionSize.trim()}
              >
                {loggingRecipeId ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Logging...
                  </>
                ) : (
                  'Log It'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
