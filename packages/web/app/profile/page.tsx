'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import type { UserProfile, Sex, ActivityLevel, HealthGoal } from 'shared';
import DashboardShell from '@/components/DashboardShell';

export default function ProfilePage() {
  const { user, supabase, loading: authLoading } = useAuth();

  const [age, setAge] = useState<string>('');
  const [weight, setWeight] = useState<string>('');
  const [height, setHeight] = useState<string>('');
  const [sex, setSex] = useState<Sex | ''>('');
  const [activityLevel, setActivityLevel] = useState<ActivityLevel | ''>('');
  const [healthGoal, setHealthGoal] = useState<HealthGoal | ''>('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [bmi, setBmi] = useState<string | null>(null);
  const [bmiCategory, setBmiCategory] = useState('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setError(null);
    setSuccessMessage(null);

    switch (name) {
      case 'age': setAge(value); break;
      case 'weight': setWeight(value); break;
      case 'height': setHeight(value); break;
      case 'sex': setSex(value as Sex | ''); break;
      case 'activityLevel': setActivityLevel(value as ActivityLevel | ''); break;
      case 'healthGoal': setHealthGoal(value as HealthGoal | ''); break;
      default: break;
    }
  };

  const calculateBMI = useCallback(() => {
    if (weight && height) {
      const heightInMeters = parseFloat(height) / 100;
      const weightInKg = parseFloat(weight);

      if (heightInMeters > 0 && weightInKg > 0) {
        const bmiValue = (weightInKg / (heightInMeters * heightInMeters)).toFixed(1);
        setBmi(bmiValue);

        const numBmi = parseFloat(bmiValue);
        if (numBmi < 18.5) setBmiCategory('Underweight');
        else if (numBmi < 25) setBmiCategory('Normal weight');
        else if (numBmi < 30) setBmiCategory('Overweight');
        else setBmiCategory('Obese');

      } else {
        setBmi(null);
        setBmiCategory('');
      }
    } else {
      setBmi(null);
      setBmiCategory('');
    }
  }, [weight, height]);

  useEffect(() => {
    calculateBMI();
  }, [weight, height, calculateBMI]);

  const fetchProfile = useCallback(async () => {
    if (!user || !supabase) return;
    console.log('Fetching profile for user:', user.id);
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const { data, error: fetchError } = await supabase
        .from('user_profiles').select('*').eq('id', user.id).single();
      if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;
      if (data) {
        console.log('Profile data fetched:', data);
        setAge(data.age?.toString() ?? '');
        setWeight(data.weight_kg?.toString() ?? '');
        setHeight(data.height_cm?.toString() ?? '');
        setSex(data.sex ?? '');
        setActivityLevel(data.activity_level ?? '');
        setHealthGoal(data.health_goal ?? '');
      } else {
        console.log('No profile found for user, form will be empty.');
      }
    } catch (err: unknown) {
      console.error('Error fetching profile:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage || 'Failed to fetch profile data.');
    } finally {
      setLoading(false);
    }
  }, [user, supabase]);

  useEffect(() => {
    if (!authLoading && user && supabase) {
      fetchProfile();
    } else if (!authLoading && (!user || !supabase)) {
      setLoading(false);
      setError("User not authenticated or connection issue.");
    }
  }, [user, supabase, authLoading, fetchProfile]);

  const handleSaveProfile = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user || !supabase) {
      setError("Cannot save profile: User not available."); return;
    }
    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    const profileDataToSave: Partial<UserProfile> = {
      id: user.id,
      age: age ? parseInt(age, 10) : null,
      weight_kg: weight ? parseFloat(weight) : null,
      height_cm: height ? parseInt(height, 10) : null,
      gender: sex || null,
      activity_level: activityLevel || null,
      health_goal: healthGoal || null,
    };

    const parsedAge = profileDataToSave.age;
    if (parsedAge != null && (isNaN(parsedAge) || parsedAge <= 0)) {
      setError("Please enter a valid age."); setSaving(false); return;
    }
    const parsedWeight = profileDataToSave.weight_kg;
    if (parsedWeight != null && (isNaN(parsedWeight) || parsedWeight <= 0)) {
      setError("Please enter a valid weight."); setSaving(false); return;
    }
    const parsedHeight = profileDataToSave.height_cm;
    if (parsedHeight != null && (isNaN(parsedHeight) || parsedHeight <= 0)) {
      setError("Please enter a valid height."); setSaving(false); return;
    }

    console.log("Saving profile data:", profileDataToSave);
    try {
      const { error: saveError } = await supabase
        .from('user_profiles').upsert(profileDataToSave, { onConflict: 'id' });
      if (saveError) throw saveError;
      console.log('Profile saved successfully.');
      setSuccessMessage('Profile updated successfully!');
    } catch (err: any) {
      console.error('Error saving profile:', err);
      const errorMessage = err.message || err.details || String(err);
      setError(errorMessage || 'Failed to save profile.');
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || loading) {
    return <div className="flex min-h-screen items-center justify-center"><p>Loading profile...</p></div>;
  }
  if (!user) {
    return <div className="flex min-h-screen items-center justify-center"><p>Please log in to view your profile.</p></div>;
  }

  return (
    <DashboardShell headerTitle="Profile">
      <div className="max-w-3xl mx-auto">
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <form onSubmit={handleSaveProfile} className="p-6 space-y-6">
            <h1 className="text-2xl font-bold text-gray-900 mb-6">Your Profile</h1>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label htmlFor="age" className="block text-sm font-medium text-gray-700 mb-1">Age</label>
                <input type="number" id="age" name="age" value={age} onChange={handleChange} placeholder="Years"
                  className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-black placeholder-black" disabled={saving} />
              </div>
              <div>
                <label htmlFor="sex" className="block text-sm font-medium text-gray-700 mb-1">Biological Sex</label>
                <select id="sex" name="sex" value={sex} onChange={handleChange}
                  className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-black" disabled={saving}>
                  <option value="">Select</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label htmlFor="weight" className="block text-sm font-medium text-gray-700 mb-1">Weight</label>
                <div className="flex">
                  <input type="number" id="weight" name="weight" value={weight} onChange={handleChange} placeholder="Weight" step="0.1"
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-l-md focus:ring-blue-500 focus:border-blue-500 text-black placeholder-black" disabled={saving} />
                  <span className="inline-flex items-center px-3 py-2 text-gray-500 bg-gray-100 border border-l-0 border-gray-300 rounded-r-md">kg</span>
                </div>
              </div>
              <div>
                <label htmlFor="height" className="block text-sm font-medium text-gray-700 mb-1">Height</label>
                <div className="flex">
                  <input type="number" id="height" name="height" value={height} onChange={handleChange} placeholder="Height"
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-l-md focus:ring-blue-500 focus:border-blue-500 text-black placeholder-black" disabled={saving} />
                  <span className="inline-flex items-center px-3 py-2 text-gray-500 bg-gray-100 border border-l-0 border-gray-300 rounded-r-md">cm</span>
                </div>
              </div>
              <div>
                <label htmlFor="activityLevel" className="block text-sm font-medium text-gray-700 mb-1">Activity Level</label>
                <select id="activityLevel" name="activityLevel" value={activityLevel} onChange={handleChange}
                  className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-black" disabled={saving}>
                  <option value="">Select</option>
                  <option value="sedentary">Sedentary (little to no exercise)</option>
                  <option value="lightly_active">Lightly active (light exercise 1-3 days/wk)</option>
                  <option value="moderately_active">Moderately active (moderate exercise 3-5 days/wk)</option>
                  <option value="very_active">Active (hard exercise 6-7 days/wk)</option>
                  <option value="extra_active">Very active (very hard exercise &amp; physical job)</option>
                </select>
              </div>
              <div>
                <label htmlFor="healthGoal" className="block text-sm font-medium text-gray-700 mb-1">Health Goal</label>
                <select id="healthGoal" name="healthGoal" value={healthGoal} onChange={handleChange}
                  className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-black" disabled={saving}>
                  <option value="">Select</option>
                  <option value="weight_loss">Lose weight</option>
                  <option value="maintenance">Maintain weight</option>
                  <option value="weight_gain">Gain weight</option>
                </select>
              </div>
            </div>

            {error && (
              <div className="mt-4 rounded border border-red-400 bg-red-100 p-3 text-center text-sm text-red-700">{error}</div>
            )}
            {successMessage && (
              <div className="mt-4 rounded border border-green-400 bg-green-100 p-3 text-center text-sm text-green-700">{successMessage}</div>
            )}

            <div className="pt-6 border-t border-gray-200">
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50">
                {saving ? 'Saving...' : 'Save Profile'}
              </button>
            </div>
          </form>

          <div className="bg-gray-50 p-6 border-t border-gray-200">
            <h3 className="text-lg font-medium text-gray-900 mb-4">BMI Overview</h3>
            {bmi ? (
              <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
                <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 text-center w-full md:w-auto">
                  <div className="text-sm text-gray-500 mb-1">Your BMI</div>
                  <div className="text-3xl font-bold text-gray-900">{bmi}</div>
                  <div className={`text-sm font-medium mt-1 ${bmiCategory === 'Normal weight' ? 'text-green-600' :
                    bmiCategory === 'Underweight' ? 'text-yellow-600' :
                      'text-red-600'
                    }`}>{bmiCategory}</div>
                </div>
                <div className="flex-1">
                  <div className="h-8 w-full bg-gray-200 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{
                      width: `${Math.min(100, Math.max(0, parseFloat(bmi) * 3))}%`,
                      background: 'linear-gradient(to right, #fde047, #86efac, #f97316, #ef4444)',
                    }} />
                  </div>
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>Underweight</span><span>Normal</span><span>Overweight</span><span>Obese</span>
                  </div>
                  <p className="text-sm text-gray-600 mt-4">
                    BMI is a measurement of a person's leanness or corpulence based on height and weight. It is used to estimate tissue mass and is widely used as a general indicator of healthy body weight.
                  </p>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-gray-500">Enter your height and weight to calculate your BMI</div>
            )}
          </div>

          {bmi && (
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-sm">
              <p><strong>Estimated BMI:</strong> {bmi} ({bmiCategory})</p>
              <p className="text-xs text-gray-600 mt-1">Note: BMI is an estimate and doesn&apos;t account for muscle mass.</p>
            </div>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}