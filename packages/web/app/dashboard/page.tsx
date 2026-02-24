'use client';

import React, { useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import FoodLogDetailModal from '@/components/FoodLogDetailModal';
import { format as formatDateFn } from 'date-fns';
import DashboardShell from '@/components/DashboardShell';
import DashboardSummaryTable from '@/components/DashboardSummaryTable';
import { useDashboardData } from '@/hooks/useDashboardData';

export const dynamic = 'force-dynamic';

const LoadingSpinner = () => {
  return (
    <div className="flex justify-center items-center py-2">
      <div className="relative w-8 h-8">
        <div className="absolute top-0 left-0 right-0 bottom-0 border-4 border-blue-100 rounded-full"></div>
        <div className="absolute top-0 left-0 right-0 bottom-0 border-4 border-transparent border-t-blue-600 rounded-full animate-spin"></div>
      </div>
    </div>
  );
};

export default function DashboardPage() {
  const { user, supabase, loading: authLoading } = useAuth();
  const {
    userGoals,
    dailyTotals,
    dailyAdjustments,
    recentLogs,
    loadingData,
    refreshing,
    error,
    refreshDashboardData
  } = useDashboardData();

  const [isLogDetailModalVisible, setIsLogDetailModalVisible] = useState(false);
  const [selectedLogData, setSelectedLogData] = useState<any>(null);
  const [isDeletingLog, setIsDeletingLog] = useState(false);

  const handleRefresh = useCallback(() => {
    refreshDashboardData(true);
  }, [refreshDashboardData]);

  const handleLogItemClick = (logItem: any) => {
    setSelectedLogData(logItem);
    setIsLogDetailModalVisible(true);
  };

  const handleCloseLogDetailModal = () => {
    if (isDeletingLog) return;
    setIsLogDetailModalVisible(false);
    setSelectedLogData(null);
  };

  const handleDeleteLogItem = async (logId: string) => {
    if (!supabase || !user) {
      alert("Delete failed: Authentication error.");
      return;
    }

    setIsDeletingLog(true);
    try {
      const { error: deleteError } = await supabase
        .from('food_log')
        .delete()
        .match({ id: logId, user_id: user.id });

      if (deleteError) throw deleteError;

      handleCloseLogDetailModal();
      refreshDashboardData(true);

    } catch (err) {
      console.error("Error deleting log item:", err);
      alert("Failed to delete log item.");
    } finally {
      setIsDeletingLog(false);
    }
  };

  if (authLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <LoadingSpinner />
        <p className="ml-2">Loading user data...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p>Please log in to view the dashboard.</p>
      </div>
    );
  }

  return (
    <DashboardShell headerTitle="Dashboard">
      {loadingData && !refreshing ? (
        <div className="flex flex-col items-center justify-center pt-20">
          <LoadingSpinner />
          <p className="mt-4 text-gray-500">Loading Dashboard...</p>
        </div>
      ) : (
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          {/* Left Panel: Today's Log */}
          <div className="lg:w-1/2 min-w-0">
            <h2 className="text-lg font-semibold text-blue-600 mb-4 px-1">Today&apos;s Log</h2>
            {recentLogs.length > 0 ? (
              <div className="bg-white border border-gray-200 rounded-lg shadow-sm divide-y divide-gray-200">
                {recentLogs.slice(0, 10).map(log => (
                  <button
                    key={log.id}
                    onClick={() => handleLogItemClick(log)}
                    className="block w-full text-left px-4 py-3 hover:bg-gray-50 focus:outline-none focus:bg-gray-50 transition-colors duration-150"
                  >
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-gray-800 truncate">
                        {log.food_name || 'Logged Item'}
                      </span>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <span className="text-sm font-semibold text-blue-600">
                          {typeof log.calories === 'number' ? `${Math.round(log.calories)} kcal` : ''}
                        </span>
                        <span className="text-xs text-gray-400">
                          {formatDateFn(new Date(log.log_time), 'h:mm a')}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
                {recentLogs.length > 10 && (
                  <Link href="/history" className="block text-center p-3 text-sm text-blue-600 hover:bg-gray-50">
                    View Full History ({recentLogs.length} items)
                  </Link>
                )}
              </div>
            ) : (
              <div className="text-center p-6 border border-gray-200 rounded-lg bg-white">
                <p className="text-sm text-gray-500">No food logged yet today.</p>
                <Link href="/chat" className="mt-2 inline-block px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded-full hover:bg-blue-200">
                  Go to Chat to Log
                </Link>
              </div>
            )}
          </div>

          {/* Right Panel: Dashboard Summary */}
          <div className="lg:w-1/2 min-w-0 overflow-x-auto">
            {error && (
              <div className="mb-6 p-3 bg-red-100 text-red-700 rounded-md border border-red-300">
                Error: {error}
              </div>
            )}
            {refreshing && (
              <div className="flex justify-center py-2 mb-4">
                <LoadingSpinner />
              </div>
            )}
            <DashboardSummaryTable
              userGoals={userGoals}
              dailyTotals={dailyTotals}
              dailyAdjustments={dailyAdjustments}
              loading={loadingData}
              error={error}
              refreshing={refreshing}
              onRefresh={handleRefresh}
            />

            <div className="mt-6">
              <Link
                href="/analytics"
                className="block bg-gray-100 hover:bg-gray-200 rounded-lg p-4 text-center transition-colors"
              >
                <div className="flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" /></svg>
                  <span className="ml-2 font-medium text-blue-600">View Nutrition Analytics</span>
                </div>
              </Link>
            </div>

            <div className="flex justify-center mt-6 mb-4">
              <button
                onClick={handleRefresh}
                disabled={refreshing || loadingData}
                className={`px-4 py-2 border border-gray-300 rounded-md text-sm font-medium ${refreshing || loadingData ? 'opacity-50 cursor-not-allowed bg-gray-50' : 'text-gray-700 bg-white hover:bg-gray-50'}`}
              >
                {refreshing ? 'Refreshing...' : 'Refresh Dashboard'}
              </button>
            </div>
          </div>
        </div>
      )}
      {isLogDetailModalVisible && (
        <FoodLogDetailModal
          logData={selectedLogData}
          onClose={handleCloseLogDetailModal}
          userGoals={userGoals}
          onDelete={handleDeleteLogItem}
        />
      )}
    </DashboardShell>
  );
}
