'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { TypingIndicator } from '@/components/LoadingIndicators';
import FoodLogDetailModal from '@/components/FoodLogDetailModal';
import Link from 'next/link';
import ChatDashboardLayout from '@/components/ChatDashboardLayout';
import DashboardShell from '@/components/DashboardShell';
import DashboardSummaryTable from '@/components/DashboardSummaryTable';
import ChatMessageList from '@/components/ChatMessageList';
import { normalizeNutrientKey, MASTER_NUTRIENT_MAP, getStartAndEndOfDay } from 'shared';

export const dynamic = 'force-dynamic';

interface ChatMessage {
  id: string | number;
  sender: 'user' | 'bot' | 'assistant' | 'error';
  text: string;
  metadata?: any;
  message_type?: string;
  flagged?: boolean;
}

interface UserGoal {
  nutrient: string;
  target_value: number;
  unit: string;
  goal_type?: string;
}

interface FoodLog {
  id: number;
  timestamp: string;
  food_name?: string | null;
  calories?: number | null;
  [key: string]: unknown;
}

interface DailyTotals {
  [nutrientKey: string]: number;
}

interface ChatSessionMeta {
  id: string;
  title: string;
  updated_at: string;
}

export default function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, supabase, loading: authLoading, session } = useAuth();

  const activeChatId = searchParams.get('id');

  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSessionMeta[]>([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);

  // --- Dashboard State ---
  const [userGoals, setUserGoals] = useState<UserGoal[]>([]);
  const [dailyTotals, setDailyTotals] = useState<DailyTotals>({});
  const [recentLogs, setRecentLogs] = useState<FoodLog[]>([]);
  const [loadingDashboardData, setLoadingDashboardData] = useState(true);
  const [refreshingDashboard, setRefreshingDashboard] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);

  // --- Modal State ---
  const [selectedLog, setSelectedLog] = useState<any>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);

  // Fetch initial messages when activeChatId changes
  useEffect(() => {
    const fetchInitialMessages = async () => {
      if (!activeChatId || !supabase) {
        setChatHistory([]);
        return;
      }

      try {
        const { data, error: dbError } = await supabase
          .from('chat_messages')
          .select('id, role, content, metadata, message_type, flagged, created_at')
          .eq('session_id', activeChatId)
          .order('created_at', { ascending: true });

        if (dbError) throw dbError;

        const formattedMessages: ChatMessage[] = data?.map((msg: any) => ({
          id: msg.id,
          sender: msg.role === 'assistant' ? 'bot' : msg.role,
          text: msg.content,
          metadata: msg.metadata,
          message_type: msg.message_type,
          flagged: msg.flagged || false
        })) || [];

        setChatHistory(formattedMessages);
      } catch (err: any) {
        console.error('Error fetching initial chat messages:', err);
        setChatHistory([]);
      }
    };

    fetchInitialMessages();
  }, [activeChatId, supabase]);

  // --- Fetch chat sessions on load ---
  const fetchChatSessions = useCallback(async () => {
    if (!user || !supabase) return;
    setLoadingChats(true);
    const { data, error } = await supabase
      .from('chat_sessions')
      .select('id, title, updated_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (!error && data) {
      setChatSessions(data);
      if (data.length > 0 && !activeChatId) {
        router.push(`/chat?id=${data[0].id}`);
      }
    }
    setLoadingChats(false);
  }, [user, supabase, activeChatId, router]);

  useEffect(() => {
    if (user && supabase) {
      fetchChatSessions();
    }
  }, [user, supabase, fetchChatSessions]);

  // --- Fetch dashboard data ---
  const fetchDashboardData = useCallback(async (forceRefresh = false) => {
    if (!user || !supabase) {
      setLoadingDashboardData(false);
      setRefreshingDashboard(false);
      return;
    }
    if (!forceRefresh) setLoadingDashboardData(true);
    setRefreshingDashboard(true);
    setDashboardError(null);

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { start: startOfDay, end: endOfDay } = getStartAndEndOfDay(new Date(), timezone);

    try {
      const [goalsResponse, logsResponse] = await Promise.all([
        supabase
          .from('user_goals')
          .select('nutrient, target_value, unit, goal_type')
          .eq('user_id', user.id),
        supabase
          .from('food_log')
          .select('*')
          .eq('user_id', user.id)
          .gte('log_time', startOfDay)
          .lte('log_time', endOfDay)
          .order('log_time', { ascending: false })
      ]);

      if (goalsResponse.error) throw goalsResponse.error;
      if (logsResponse.error) throw logsResponse.error;

      const fetchedGoals = goalsResponse.data || [];
      const fetchedLogs = logsResponse.data || [];

      // Deduplicate goals by normalized key
      const uniqueGoalsMap = new Map<string, UserGoal>();
      fetchedGoals.forEach(g => {
        const normalized = normalizeNutrientKey(g.nutrient);
        const existing = uniqueGoalsMap.get(normalized);
        if (!existing || g.target_value > existing.target_value) {
          uniqueGoalsMap.set(normalized, { ...g, nutrient: normalized });
        }
      });
      const finalGoals = Array.from(uniqueGoalsMap.values());

      setUserGoals(finalGoals);
      setRecentLogs(fetchedLogs.slice(0, 5));

      const totals: DailyTotals = {};
      fetchedLogs.forEach(log => {
        Object.keys(log).forEach(key => {
          if (typeof log[key] === 'number') {
            const normalizedKey = normalizeNutrientKey(key);
            totals[normalizedKey] = (totals[normalizedKey] || 0) + (log[key] as number);
          }
        });
      });

      setDailyTotals(totals);

    } catch (err: unknown) {
      console.error("Error fetching dashboard data:", err);
      setDashboardError("Failed to load dashboard data");
    } finally {
      setLoadingDashboardData(false);
      setRefreshingDashboard(false);
    }
  }, [user, supabase]);

  useEffect(() => {
    if (user && supabase) {
      fetchDashboardData();
    }
  }, [user, supabase, fetchDashboardData]);

  const processBotReply = (responseData: any): ChatMessage => ({
    id: `bot-${Date.now()}`,
    sender: responseData.status === 'error' ? 'error' : 'bot',
    text: responseData.message || 'Sorry, I received an empty response.',
    metadata: responseData.data,
    message_type: responseData.response_type,
  });

  const handleNewChat = async () => {
    if (!user || !supabase) return;
    const now = new Date();
    const title = `Chat ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert([{ user_id: user.id, title }])
      .select('id')
      .single();
    if (!error && data) {
      router.push(`/chat?id=${data.id}`);
      setChatHistory([]);
      setMessage('');
      fetchChatSessions();
    }
  };

  const handleSelectChat = (chatId: string) => {
    router.push(`/chat?id=${chatId}`);
    setMessage('');
  };

  const handleDeleteChat = async (chatId: string) => {
    if (!supabase) return;
    try {
      const { error } = await supabase
        .from('chat_sessions')
        .delete()
        .eq('id', chatId);

      if (error) throw error;

      if (activeChatId === chatId) {
        router.push('/chat');
      }
      fetchChatSessions();
    } catch (err) {
      console.error('Error deleting chat:', err);
      alert('Failed to delete chat');
    }
  };

  const handleSend = async (e?: React.FormEvent<HTMLFormElement>, actionPayload?: string, isHidden = false) => {
    if (e) e.preventDefault();
    const textToSend = actionPayload || message.trim();
    if (!textToSend || sending || authLoading || !activeChatId || !supabase) return;

    setSending(true);
    setCurrentStep('Communicating with NutriPal...');

    if (!isHidden) {
      const userMessage: ChatMessage = { id: Date.now(), sender: 'user', text: textToSend };
      setChatHistory(prev => [...prev, userMessage]);
    }
    setMessage('');

    try {
      // Use standard fetch for streaming
      const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/chat-handler`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
          'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
        },
        body: JSON.stringify({
          message: textToSend,
          session_id: activeChatId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        // Process all complete lines except the last one which might be partial
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const json = JSON.parse(line.substring(6));

              if (json.step) {
                setCurrentStep(json.step);
              } else if (json.status) {
                // Final result
                const botMessage = processBotReply(json);
                setChatHistory(prev => [...prev, botMessage]);
                setCurrentStep(null);

                if (json.response_type === 'food_logged' ||
                  json.response_type === 'recipe_logged' ||
                  json.response_type === 'goal_updated' ||
                  json.response_type === 'goals_updated') {
                  fetchDashboardData(true);
                }
              }
            } catch (e) {
              console.error('Error parsing stream chunk:', e, line);
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Error sending message:', error);
      setChatHistory(prev => [...prev, {
        id: Date.now() + 2,
        sender: 'error',
        text: `Error: ${error.message}`
      }]);
      setCurrentStep(null);
    } finally {
      setSending(false);
    }
  };

  const handleFlagMessage = async (messageId: number) => {
    console.log('[ChatPage] Flagging message:', messageId);
    // TODO: Implement flag message logic
  };

  const handleViewLogDetail = (logData: any) => {
    setSelectedLog(logData);
    setShowDetailModal(true);
  };

  const handleDeleteLogItem = async (logId: string | number) => {
    if (!supabase) return;
    try {
      const { error } = await supabase
        .from('food_log')
        .delete()
        .eq('id', logId);

      if (error) throw error;
      setShowDetailModal(false);
      fetchDashboardData(true);
    } catch (err) {
      console.error('Error deleting log item:', err);
      alert('Failed to delete log item');
    }
  };

  if (authLoading) return <div className="flex justify-center items-center h-screen"><TypingIndicator /></div>;

  if (!user || !session) {
    return (
      <div className="flex flex-col justify-center items-center h-screen bg-gray-100">
        <h1 className="text-2xl font-semibold mb-4">Welcome to NutriPal</h1>
        <p className="mb-6 text-gray-600">Please log in to access your chat and dashboard.</p>
        <Link href="/login" className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">
          Log In
        </Link>
      </div>
    );
  }

  const chatPanelContent = (
    <div className="flex-1 flex flex-col h-full bg-gray-100 overflow-hidden">
      <ChatMessageList
        activeChatId={activeChatId}
        messages={chatHistory}
        userGoals={userGoals}
        onFlagMessage={handleFlagMessage}
        onSendMessage={(text, isHidden) => handleSend(undefined, text, isHidden)}
        onViewLogDetail={handleViewLogDetail}
      />
      {sending && (
        <div className="px-4 py-2 flex flex-col items-start space-y-1">
          <TypingIndicator />
          {currentStep && (
            <span className="text-xs text-gray-500 font-medium animate-pulse ml-1">
              {currentStep}
            </span>
          )}
        </div>
      )}
      <div className="p-4 bg-white border-t border-gray-200 flex-shrink-0">
        <form onSubmit={handleSend} className="flex items-center space-x-3">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={sending ? "Waiting for response..." : "Type your message..."}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-full text-black placeholder-black focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
            disabled={sending || !activeChatId}
          />
          <button
            type="submit"
            disabled={sending || !message.trim() || !activeChatId}
            className="px-5 py-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50 transition-colors duration-200"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );

  const dashboardPanelContent = (
    <div className="flex-1 p-4 bg-gray-50">
      <DashboardSummaryTable
        userGoals={userGoals}
        dailyTotals={dailyTotals}
        loading={loadingDashboardData}
        error={dashboardError}
        refreshing={refreshingDashboard}
        onRefresh={() => fetchDashboardData(true)}
      />
    </div>
  );

  return (
    <DashboardShell
      headerTitle="Chat & Dashboard"
      chatSessions={chatSessions.map(s => ({ chat_id: s.id, title: s.title, updated_at: s.updated_at }))}
      activeChatId={activeChatId || undefined}
      onSelectChat={handleSelectChat}
      onDeleteChat={handleDeleteChat}
      onNewChat={handleNewChat}
    >
      <ChatDashboardLayout
        chatPanel={chatPanelContent}
        dashboardPanel={dashboardPanelContent}
      />

      {showDetailModal && selectedLog && (
        <FoodLogDetailModal
          logData={selectedLog}
          onClose={() => setShowDetailModal(false)}
          userGoals={userGoals}
          onDelete={selectedLog.id ? () => handleDeleteLogItem(selectedLog.id) : undefined}
        />
      )}
    </DashboardShell>
  );
}
