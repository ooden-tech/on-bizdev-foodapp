'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';

// Nutrient Definitions (imported from shared)
import { MASTER_NUTRIENT_MAP } from 'shared';

const MASTER_NUTRIENT_LIST = Object.entries(MASTER_NUTRIENT_MAP).map(([key, info]) => ({
  key,
  name: info.name,
  unit: info.unit
}));

interface TrackedGoalState {
  tracked: boolean;
  target: string; // Store target as string for input field
  goalType: 'goal' | 'limit'; // Add goal type
}

export default function GoalSettingsPage() {
  const { user, supabase, loading: authLoading } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [trackedGoals, setTrackedGoals] = useState<Record<string, TrackedGoalState>>({});
  const [initialGoals, setInitialGoals] = useState<Record<string, TrackedGoalState>>({}); // Store initial state for comparison
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false); // Track unsaved changes
  const [loading, setLoading] = useState(true); // Loading goals state
  const [saving, setSaving] = useState(false); // Saving goals state
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // --- Ref to track if component is mounted ---
  const isMounted = useRef(false);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // Fetch initial goals, including goal_type
  const fetchGoals = useCallback(async () => {
    if (!user || !supabase) return;
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const { data, error: fetchError } = await supabase
        .from('user_goals')
        .select('nutrient, target_value, goal_type')
        .eq('user_id', user.id);

      if (fetchError) throw fetchError;

      const initialGoalsState: Record<string, TrackedGoalState> = {};
      MASTER_NUTRIENT_LIST.forEach(nutrient => {
        const existingGoal = data?.find(goal => goal.nutrient === nutrient.key);
        initialGoalsState[nutrient.key] = {
          tracked: !!existingGoal,
          target: existingGoal?.target_value?.toString() || '',
          goalType: existingGoal?.goal_type === 'limit' ? 'limit' : 'goal',
        };
      });
      setTrackedGoals(initialGoalsState);
      setInitialGoals(JSON.parse(JSON.stringify(initialGoalsState))); // Deep copy for initial state
      setHasUnsavedChanges(false); // Reset unsaved changes flag after fetch

    } catch (err: unknown) {
      console.error("Error fetching goals:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to load goals: ${errorMessage}`);
    } finally {
      setLoading(false);
    }

  }, [user, supabase]);

  // Fetch on mount or auth change
  useEffect(() => {
    if (!authLoading && user) {
      fetchGoals();
    } else if (!authLoading && !user) {
      setLoading(false); // Not loading if not logged in
    }
  }, [authLoading, user, fetchGoals]);

  // --- Effect to detect unsaved changes ---
  useEffect(() => {
    // Compare current trackedGoals with initialGoals
    // Ensure initialGoals is not empty before comparing
    if (Object.keys(initialGoals).length > 0) {
      const changed = JSON.stringify(trackedGoals) !== JSON.stringify(initialGoals);
      if (isMounted.current) { // Only update state if mounted
        setHasUnsavedChanges(changed);
      }
    }
  }, [trackedGoals, initialGoals]);

  // --- Effect for "Save before leaving" prompt ---
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        event.preventDefault();
        // Standard way to trigger the browser's confirmation dialog
        event.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [hasUnsavedChanges]); // Depend on the unsaved changes flag

  // Menu close on outside click effect (Copied)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (menuOpen && !target.closest('.sidebar') && !target.closest('.menu-button')) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // == Event Handlers ==
  const handleToggleTracked = (key: string) => {
    setError(null);
    setSuccessMessage(null);
    // Reset unsaved changes status handled by the useEffect hook watching trackedGoals
    setTrackedGoals(prev => {
      const newState = { ...prev };
      const currentGoal = newState[key] || { tracked: false, target: '', goalType: 'goal' }; // Ensure default
      const isNowTracked = !currentGoal.tracked;
      newState[key] = {
        ...currentGoal,
        tracked: isNowTracked,
        // Clear target and reset type only when untracking
        target: isNowTracked ? currentGoal.target : '',
        goalType: isNowTracked ? currentGoal.goalType : 'goal',
      };
      return newState;
    });
  };

  const handleTargetChange = (key: string, value: string) => {
    setError(null);
    setSuccessMessage(null);
    // Reset unsaved changes status handled by the useEffect hook watching trackedGoals
    if (value === '' || /^\d*\.?\d*$/.test(value)) {
      setTrackedGoals(prev => {
        const currentGoal = prev[key] || { tracked: false, target: '', goalType: 'goal' };
        return {
          ...prev,
          [key]: {
            ...currentGoal,
            tracked: true, // Setting a target implies tracking
            target: value,
            // Keep existing goalType when target changes
          },
        };
      });
    }
  };

  // Add handler for goal type change
  const handleGoalTypeChange = (key: string, value: 'goal' | 'limit') => {
    setError(null);
    setSuccessMessage(null);
    // Reset unsaved changes status handled by the useEffect hook watching trackedGoals
    setTrackedGoals(prev => {
      const currentGoal = prev[key] || { tracked: true, target: '', goalType: 'goal' }; // Assume tracked if changing type
      return {
        ...prev,
        [key]: {
          ...currentGoal,
          tracked: true, // Ensure tracked is true
          goalType: value,
        }
      }
    });
  };

  const handleSaveGoals = async () => {
    if (!user || !supabase) {
      setError("Cannot save goals: Not authenticated.");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    const goalsToSave = [];
    let validationError = null;

    // Filter and validate goals from state, include goal_type
    for (const nutrient of MASTER_NUTRIENT_LIST) {
      const key = nutrient.key;
      const currentGoalState = trackedGoals[key];
      if (currentGoalState?.tracked) {
        const targetStr = currentGoalState.target;
        if (targetStr === '' || targetStr === null || targetStr === undefined) {
          validationError = `Target value is required for tracked nutrient: ${nutrient.name}.`;
          break;
        }
        const targetValue = parseFloat(targetStr);
        if (isNaN(targetValue) || targetValue < 0) {
          validationError = `Invalid target value for ${nutrient.name}: must be a non-negative number.`;
          break;
        }
        // Ensure user_id, nutrient, target_value, unit, goal_type are included
        goalsToSave.push({
          user_id: user.id,
          nutrient: key,
          target_value: targetValue,
          unit: nutrient.unit,
          goal_type: currentGoalState.goalType || 'goal'
        });
      }
    }

    if (validationError) {
      setError(validationError);
      setSaving(false);
      return;
    }

    // --- Refactored Saving Logic using Upsert ---
    try {
      if (goalsToSave.length > 0) {
        // If there are goals to save, upsert them
        console.log("Upserting goals:", goalsToSave);
        const { data, error: upsertError } = await supabase
          .from('user_goals')
          .upsert(goalsToSave, {
            onConflict: 'user_id, nutrient' // Specify conflict target
          })
          .select(); // Optionally select to confirm/log results

        if (upsertError) {
          throw upsertError;
        }
        console.log("Goals upserted successfully:", data);
      }
      // Removed the 'else' block that deleted all goals if goalsToSave was empty
      // This was potentially dangerous. Deletion is now handled separately.

      // --- Add Deletion Logic ---
      // Determine which nutrients were previously tracked but are now untracked
      const previouslyTrackedKeys = Object.keys(initialGoals).filter(key => initialGoals[key]?.tracked);
      const currentlyTrackedKeys = Object.keys(trackedGoals).filter(key => trackedGoals[key]?.tracked);
      const keysToDelete = previouslyTrackedKeys.filter(key => !currentlyTrackedKeys.includes(key));

      if (keysToDelete.length > 0) {
        console.log("Deleting untracked goals for nutrients:", keysToDelete);
        const { error: deleteError } = await supabase
          .from('user_goals')
          .delete()
          .eq('user_id', user.id)
          .in('nutrient', keysToDelete);

        if (deleteError) {
          // Log the error but potentially allow the success message if upsert worked
          console.error("Error deleting untracked goals:", deleteError);
          setError(`Goals saved, but failed to remove untracked goals: ${deleteError.message}`);
          // Don't throw here, let the success message show if upsert was ok
        } else {
          console.log("Untracked goals deleted successfully.");
        }
      }
      // --- End Deletion Logic ---

      setSuccessMessage("Goals saved successfully!");
      // IMPORTANT: Reset initial state to current state after successful save
      if (isMounted.current) { // Check if mounted before setting state
        setInitialGoals(JSON.parse(JSON.stringify(trackedGoals)));
        setHasUnsavedChanges(false); // Explicitly set false after save
      }

    } catch (err: unknown) {
      console.error("Error saving goals:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to save goals: ${errorMessage}`);
      setSuccessMessage(null); // Clear success message on error
    } finally {
      if (isMounted.current) { // Check if mounted before setting state
        setSaving(false);
      }
    }
  };

  // Loading/Auth checks
  if (authLoading || loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p>Loading Goal Settings...</p>
        {/* Optional Spinner */}
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p>Please log in to set nutrient goals.</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50 relative overflow-hidden">
      {/* Sidebar navigation */}
      <div className={`sidebar fixed top-0 left-0 h-full w-64 bg-white shadow-lg z-50 transform transition-transform duration-300 ease-in-out ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-4 border-b border-gray-200 flex justify-between items-center">
          <h2 className="text-xl font-semibold text-gray-800">NutriPal</h2>
          <button onClick={() => setMenuOpen(false)} className="p-2 rounded-md text-gray-600 hover:bg-gray-100">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        {/* Navigation Links - Settings Active */}
        <nav className="flex-1 p-4 space-y-1">
          <Link href="/dashboard" className="block px-3 py-2 text-gray-600 rounded-md hover:bg-gray-100">Dashboard</Link>
          <Link href="/profile" className="block px-3 py-2 text-gray-600 rounded-md hover:bg-gray-100">Profile</Link>
          <Link href="/analytics" className="block px-3 py-2 text-gray-600 rounded-md hover:bg-gray-100">Analytics</Link>
          <Link href="/recipes" className="block px-3 py-2 text-gray-600 rounded-md hover:bg-gray-100">Saved Recipes</Link>
          <Link href="/chat" className="block px-3 py-2 text-gray-600 rounded-md hover:bg-gray-100">Chat</Link>
          <Link href="/settings" className="block px-3 py-2 bg-blue-50 text-blue-700 rounded-md font-medium">Settings</Link> {/* Active Parent */}
        </nav>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header with Hamburger */}
        <header className="bg-white border-b border-gray-200 p-4 z-10 flex-shrink-0">
          <div className="flex items-center justify-between">
            <button className="menu-button p-2 rounded-md text-gray-600 hover:bg-gray-100" onClick={() => setMenuOpen(true)}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <h2 className="text-xl font-semibold text-gray-800">Nutrient Goals</h2>
            <div className="w-8"></div> { /* Balance */}
          </div>
        </header>

        {/* Goal Settings Content */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto bg-white p-6 rounded-lg shadow border border-gray-200">
            <h2 className="text-xl font-semibold text-gray-800 mb-4">Manage Nutrient Tracking</h2>
            <p className="text-sm text-gray-600 mb-6">Select the nutrients you want to track and set your daily targets. Targets can be a 'Goal' (minimum) or a 'Limit' (maximum).</p>

            {/* Feedback Messages */}
            {error && (
              <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-md border border-red-300">
                {error}
              </div>
            )}
            {successMessage && (
              <div className="mb-4 p-3 bg-green-100 text-green-700 rounded-md border border-green-300">
                {successMessage}
              </div>
            )}

            {/* Nutrient List */}
            <div className="space-y-4">
              {MASTER_NUTRIENT_LIST.map((nutrient) => {
                const key = nutrient.key;
                const goalState = trackedGoals[key] || { tracked: false, target: '', goalType: 'goal' };
                return (
                  <div key={key} className="p-4 border rounded-md flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 hover:bg-gray-50 transition-colors">
                    <div className="flex items-center flex-grow">
                      <input
                        type="checkbox"
                        id={`track-${key}`}
                        checked={goalState.tracked}
                        onChange={() => handleToggleTracked(key)}
                        className="h-5 w-5 text-blue-600 border-gray-300 rounded focus:ring-blue-500 mr-3"
                      />
                      <label htmlFor={`track-${key}`} className="text-sm font-medium text-gray-900">
                        {nutrient.name}
                      </label>
                    </div>

                    <div className="flex items-center gap-2 w-full sm:w-auto flex-shrink-0">
                      {goalState.tracked ? (
                        <>
                          <select
                            id={`goalType-${key}`}
                            value={goalState.goalType}
                            onChange={(e) => handleGoalTypeChange(key, e.target.value as 'goal' | 'limit')}
                            className="h-9 block w-24 py-1.5 px-2 border border-gray-300 bg-white rounded-md shadow-sm text-sm text-black focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          >
                            <option value="goal">Goal</option>
                            <option value="limit">Limit</option>
                          </select>
                          <input
                            type="text"
                            id={`target-${key}`}
                            value={goalState.target}
                            onChange={(e) => handleTargetChange(key, e.target.value)}
                            placeholder={`Target`}
                            className="h-9 block w-28 py-1.5 px-3 border border-gray-300 rounded-md shadow-sm text-sm text-black placeholder-black focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                            inputMode="decimal"
                          />
                          <span className="text-sm text-gray-500 w-12 text-left">{nutrient.unit}</span>
                        </>
                      ) : (
                        <div className="h-9 w-full"></div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Sticky Save Button Area */}
            <div className="sticky bottom-0 left-0 right-0 bg-white bg-opacity-90 backdrop-blur-sm p-4 border-t border-gray-200 shadow-top z-10">
              <div className="max-w-6xl mx-auto flex items-center justify-end space-x-4">
                {error && <p className="text-red-600 text-sm mr-auto">{error}</p>} {/* Push error left */}
                {successMessage && <p className="text-green-600 text-sm mr-auto">{successMessage}</p>} {/* Push success left */}
                {/* Add a visual indicator for unsaved changes */}
                {hasUnsavedChanges && !saving && <p className="text-yellow-600 text-sm font-medium">Unsaved changes</p>}
                <button
                  onClick={handleSaveGoals}
                  disabled={saving || !hasUnsavedChanges} // Disable if saving or no changes
                  className={`px-6 py-2 rounded-md text-white font-semibold transition-colors ${saving || !hasUnsavedChanges
                      ? 'bg-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                >
                  {saving ? 'Saving...' : 'Save Goals'}
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
} 