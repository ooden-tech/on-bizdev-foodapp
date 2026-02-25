'use client';

import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { useAuth } from './AuthContext';
import type { DisplayUnits } from '@/utils/formatting';

export interface ProfileContextType {
    displayUnits: DisplayUnits;
    setDisplayUnits: (units: DisplayUnits) => void;
}

const DEFAULT_UNITS: DisplayUnits = { volume: 'ml', weight: 'g', energy: 'kcal' };

const ProfileContext = createContext<ProfileContextType>({
    displayUnits: DEFAULT_UNITS,
    setDisplayUnits: () => { },
});

export const useProfile = () => useContext(ProfileContext);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
    const { user, supabase, loading } = useAuth();
    const [displayUnits, setDisplayUnits] = useState<DisplayUnits>(DEFAULT_UNITS);

    useEffect(() => {
        if (!user || !supabase || loading) return;

        let isMounted = true;

        const fetchProfile = async () => {
            try {
                const { data, error } = await supabase
                    .from('user_profiles')
                    .select('display_units')
                    .eq('id', user.id)
                    .maybeSingle();

                if (error) throw error;

                if (isMounted && data?.display_units) {
                    setDisplayUnits({ ...DEFAULT_UNITS, ...data.display_units });
                }
            } catch (err) {
                console.error('[ProfileProvider] Error fetching profile:', err);
            }
        };

        fetchProfile();

        return () => {
            isMounted = false;
        };
    }, [user, supabase, loading]);

    const value = useMemo(() => ({
        displayUnits,
        setDisplayUnits
    }), [displayUnits]);

    return (
        <ProfileContext.Provider value={value}>
            {children}
        </ProfileContext.Provider>
    );
}
