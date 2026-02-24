'use client';

import React, { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import DashboardShell from '@/components/DashboardShell';

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

export default function SettingsPage() {
  const { user, supabase, loading, error, signOut } = useAuth();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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
      <div className="max-w-xl mx-auto bg-white p-6 rounded-lg shadow border border-gray-200">
        <h2 className="text-xl font-semibold text-gray-800 mb-6">Settings</h2>
        <div className="space-y-4">
          <Link
            href="/settings/goals"
            className="block p-4 border rounded-md hover:bg-gray-50 transition-colors duration-150"
          >
            <h3 className="font-medium text-blue-600">Nutrient Goals</h3>
            <p className="text-sm text-gray-600 mt-1">Manage which nutrients you&apos;re tracking and set your daily targets.</p>
          </Link>

          <button
            onClick={handleSignOut}
            disabled={signingOut || loading}
            className="w-full mt-6 flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
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