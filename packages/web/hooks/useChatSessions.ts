'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';

export interface ChatSessionMeta {
    chat_id: string;
    title: string;
    updated_at: string;
}

interface UseChatSessionsReturn {
    chatSessions: ChatSessionMeta[];
    activeChatId: string | null;
    loadingChats: boolean;
    handleNewChat: () => Promise<void>;
    handleSelectChat: (chatId: string) => void;
    handleDeleteChat: (chatId: string) => Promise<void>;
    refreshChatSessions: () => Promise<void>;
}

export function useChatSessions(): UseChatSessionsReturn {
    const { user, supabase } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [chatSessions, setChatSessions] = useState<ChatSessionMeta[]>([]);
    const [loadingChats, setLoadingChats] = useState(false);

    // Only derive activeChatId when on the /chat page
    const activeChatId = pathname === '/chat' ? searchParams.get('id') : null;

    const fetchChatSessions = useCallback(async () => {
        if (!user || !supabase) return;
        setLoadingChats(true);
        try {
            const { data, error } = await supabase
                .from('chat_sessions')
                .select('id, title, updated_at')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (!error && data) {
                setChatSessions(
                    data.map((s: any) => ({
                        chat_id: s.id,
                        title: s.title,
                        updated_at: s.updated_at,
                    }))
                );
            }
        } catch (err) {
            console.error('Error fetching chat sessions:', err);
        } finally {
            setLoadingChats(false);
        }
    }, [user, supabase]);

    useEffect(() => {
        if (user && supabase) {
            fetchChatSessions();
        }
    }, [user, supabase, fetchChatSessions]);

    const handleNewChat = useCallback(async () => {
        if (!user || !supabase) return;
        const now = new Date();
        const title = `Chat ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
        try {
            const { data, error } = await supabase
                .from('chat_sessions')
                .insert([{ user_id: user.id, title }])
                .select('id')
                .single();
            if (!error && data) {
                router.push(`/chat?id=${data.id}`);
                fetchChatSessions();
            }
        } catch (err) {
            console.error('Error creating new chat:', err);
        }
    }, [user, supabase, router, fetchChatSessions]);

    const handleSelectChat = useCallback(
        (chatId: string) => {
            router.push(`/chat?id=${chatId}`);
        },
        [router]
    );

    const handleDeleteChat = useCallback(
        async (chatId: string) => {
            if (!supabase) return;
            try {
                const { error } = await supabase
                    .from('chat_sessions')
                    .delete()
                    .eq('id', chatId);

                if (error) throw error;

                // If we deleted the currently active chat, navigate to /chat
                if (activeChatId === chatId) {
                    router.push('/chat');
                }
                fetchChatSessions();
            } catch (err) {
                console.error('Error deleting chat:', err);
                alert('Failed to delete chat');
            }
        },
        [supabase, activeChatId, router, fetchChatSessions]
    );

    return {
        chatSessions,
        activeChatId,
        loadingChats,
        handleNewChat,
        handleSelectChat,
        handleDeleteChat,
        refreshChatSessions: fetchChatSessions,
    };
}
