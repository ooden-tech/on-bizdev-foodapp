'use client';

import React, { useState, useEffect, ReactNode, Suspense } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useChatSessions } from '@/hooks/useChatSessions';

interface DashboardShellProps {
  children: ReactNode;
  headerTitle?: string;
  headerRight?: ReactNode;
}

function DashboardShellInner({ children, headerTitle = 'Dashboard', headerRight }: DashboardShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { user } = useAuth();
  const pathname = usePathname();
  const {
    chatSessions,
    activeChatId,
    handleNewChat,
    handleSelectChat,
    handleDeleteChat,
  } = useChatSessions();

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

  const isActive = (href: string) =>
    pathname === href ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100';

  return (
    <div className="app-root flex h-screen bg-white relative overflow-hidden">
      {/* Sidebar */}
      <div className={`sidebar fixed top-0 left-0 h-full w-64 bg-white shadow-lg z-50 transform transition-transform duration-300 ease-in-out ${menuOpen ? 'translate-x-0' : '-translate-x-full'} flex flex-col`}>
        <div className="p-4 border-b border-gray-200 flex justify-between items-center flex-shrink-0">
          <h2 className="text-xl font-semibold text-gray-800">NutriPal</h2>
          <button onClick={() => setMenuOpen(false)} className="p-2 rounded-md text-gray-600 hover:bg-gray-100">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          <Link href="/dashboard" className={`block px-3 py-2 rounded-md ${isActive('/dashboard')}`}>Dashboard</Link>
          <Link href="/profile" className={`block px-3 py-2 rounded-md ${isActive('/profile')}`}>Profile</Link>
          <Link href="/analytics" className={`block px-3 py-2 rounded-md ${isActive('/analytics')}`}>Analytics</Link>
          <Link href="/recipes" className={`block px-3 py-2 rounded-md ${isActive('/recipes')}`}>Saved Recipes</Link>
          <Link href="/chat" className={`block px-3 py-2 rounded-md ${isActive('/chat')}`}>Chat</Link>
          <Link href="/settings" className={`block px-3 py-2 rounded-md ${isActive('/settings')}`}>Settings</Link>
          {user?.email?.includes('admin') && (
            <Link href="/admin" className={`block px-3 py-2 rounded-md ${isActive('/admin')} mt-4 border-t border-gray-200 pt-4`}>
              <span className="flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                </svg>
                Admin
              </span>
            </Link>
          )}
        </nav>
        {/* Chats Section — always rendered with live data */}
        <div className="border-t border-gray-200 p-4 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-700">Chats</span>
            <button
              onClick={handleNewChat}
              className="px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"
              title="Start a new chat"
            >
              + New
            </button>
          </div>
          <ul className="space-y-1 max-h-48 overflow-y-auto">
            {chatSessions.length === 0 && (
              <li className="text-xs text-gray-400">No chats yet</li>
            )}
            {chatSessions.map((chat) => (
              <li key={chat.chat_id} className="group flex items-center justify-between">
                <button
                  className={`flex-1 text-left px-2 py-1 rounded text-sm ${chat.chat_id === activeChatId ? 'bg-blue-100 text-blue-700 font-semibold' : 'hover:bg-gray-100 text-gray-700'}`}
                  onClick={() => handleSelectChat(chat.chat_id)}
                >
                  <span className="block truncate">{chat.title}</span>
                  <span className="block text-xs text-gray-400">{new Date(chat.updated_at).toLocaleString()}</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Are you sure you want to delete this chat?')) {
                      handleDeleteChat(chat.chat_id);
                    }
                  }}
                  className="p-1 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete chat"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h14" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 p-4 z-10 flex-shrink-0">
          <div className="flex items-center justify-between">
            <button className="menu-button p-2 rounded-md text-gray-600 hover:bg-gray-100" onClick={() => setMenuOpen(true)}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <h2 className="text-xl font-semibold text-gray-800">{headerTitle}</h2>
            {headerRight || <div className="w-8"></div>}
          </div>
        </header>
        {/* Main Content */}
        <main className="flex-1 overflow-y-auto p-3 md:p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

const DashboardShell: React.FC<DashboardShellProps> = (props) => {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center"><p>Loading...</p></div>}>
      <DashboardShellInner {...props} />
    </Suspense>
  );
};

export default DashboardShell;