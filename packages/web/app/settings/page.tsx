'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import DashboardShell from '@/components/DashboardShell';
import type { DisplayUnits, VolumeUnit, WeightUnit, EnergyUnit } from '@/utils/formatting';

// Loading Spinner Component
const LoadingSpinner = () => {
  return (
    <div className="flex justify-center items-center">
      <div className="relative w-5 h-5">
        <div className="absolute top-0 left-0 right-0 bottom-0 border-2 border-red-100 rounded-full"></div>
        <div className="absolute top-0 left-0 right-0 bottom-0 border-2 border-transparent border-t-red-600 rounded-full animate-spin"></div>
      </div>
    </div>
  );
};

const UNIT_OPTIONS = {
  volume: [
    { value: 'ml', label: 'Milliliters (ml)' },
    { value: 'oz', label: 'Fluid Ounces (fl oz)' },
    { value: 'L', label: 'Liters (L)' },
  ],
  weight: [
    { value: 'g', label: 'Grams (g)' },
    { value: 'oz', label: 'Ounces (oz)' },
    { value: 'lb', label: 'Pounds (lb)' },
  ],
  energy: [
    { value: 'kcal', label: 'Calories (kcal)' },
    { value: 'kj', label: 'Kilojoules (kJ)' },
  ],
};

const DEFAULT_UNITS: DisplayUnits = { volume: 'ml', weight: 'g', energy: 'kcal' };

export default function SettingsPage() {
  const { user, supabase, loading, error, signOut } = useAuth();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [displayUnits, setDisplayUnits] = useState<DisplayUnits>(DEFAULT_UNITS);
  const [unitsSaving, setUnitsSaving] = useState(false);
  const [unitsMessage, setUnitsMessage] = useState<string | null>(null);

  // Load current display_units from user profile
  useEffect(() => {
    if (!user || !supabase) return;
    (async () => {
      const { data } = await supabase
        .from('user_profiles')
        .select('display_units')
        .eq('id', user.id)
        .maybeSingle();
      if (data?.display_units) {
        setDisplayUnits({ ...DEFAULT_UNITS, ...data.display_units });
      }
    })();
  }, [user, supabase]);

  const saveUnits = useCallback(async (newUnits: DisplayUnits) => {
    if (!user || !supabase) return;
    setUnitsSaving(true);
    setUnitsMessage(null);
    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({ display_units: newUnits })
        .eq('id', user.id);
      if (error) throw error;
      setDisplayUnits(newUnits);
      setUnitsMessage('Units saved!');
      setTimeout(() => setUnitsMessage(null), 2000);
    } catch (e: any) {
      setUnitsMessage(`Error: ${e.message}`);
    } finally {
      setUnitsSaving(false);
    }
  }, [user, supabase]);

  const handleUnitChange = (category: keyof DisplayUnits, value: string) => {
    const updated = { ...displayUnits, [category]: value };
    setDisplayUnits(updated);
    saveUnits(updated);
  };

  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      console.log("SettingsPage: Attempting sign out...");
      const { error } = await signOut();
      console.log("SettingsPage: Sign out completed.", { error });
      console.log("SettingsPage: Redirecting to /login...");
      router.replace('/login');

      if (error) {
        console.error(`Sign Out Error (handled by redirect): ${error.message}`);
      }
    } catch (error: any) {
      console.error('Sign Out unexpected error:', error);
      router.replace('/login');
    }
  }, [signOut, signingOut, router]);

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <DashboardShell headerTitle="Settings">
      <div className="max-w-xl mx-auto space-y-6">
        {/* Nutrient Goals */}
        <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
          <h2 className="text-xl font-semibold text-gray-800 mb-4">Settings</h2>
          <Link
            href="/settings/goals"
            className="block p-4 border rounded-md hover:bg-gray-50 transition-colors duration-150"
          >
            <h3 className="font-medium text-blue-600">Nutrient Goals</h3>
            <p className="text-sm text-gray-600 mt-1">Manage which nutrients you&apos;re tracking and set your daily targets.</p>
          </Link>
        </div>

        {/* Display Units */}
        <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Display Units</h2>
          <p className="text-sm text-gray-500 mb-4">Choose how numbers appear in your dashboard and tracker.</p>

          <div className="space-y-4">
            {(Object.entries(UNIT_OPTIONS) as [keyof DisplayUnits, typeof UNIT_OPTIONS['volume']][]).map(([category, options]) => (
              <div key={category} className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700 capitalize">{category}</label>
                <select
                  value={displayUnits[category] || ''}
                  onChange={(e) => handleUnitChange(category, e.target.value)}
                  disabled={unitsSaving}
                  className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                >
                  {options.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {unitsMessage && (
            <p className={`text-sm mt-3 ${unitsMessage.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>
              {unitsMessage}
            </p>
          )}
        </div>

        {/* Sign Out */}
        <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
          <button
            onClick={handleSignOut}
            disabled={signingOut || loading}
            className="w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {signingOut ? (
              <LoadingSpinner />
            ) : (
              'Sign Out'
            )}
          </button>
        </div>
      </div>
    </DashboardShell>
  );
}