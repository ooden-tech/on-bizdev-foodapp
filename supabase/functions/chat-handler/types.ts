
export interface UserProfile {
    height_cm?: number;
    weight_kg?: number;
    age?: number;
    gender?: string;
    activity_level?: string;
    goal?: string; // 'lose_weight', 'gain_muscle', etc.
    dietary_preferences?: string[];
}

export interface UserGoal {
    nutrient: string;
    target_value: number;
    unit: string;
    yellow_min?: number;
    green_min?: number;
    red_min?: number;
}

export interface HealthConstraint {
    category: string;
    type: string; // 'allergy', 'condition', 'preference'
    severity: string; // 'critical', 'warning', 'info'
    notes?: string;
}

export interface Memory {
    category: string;
    content: string;
    created_at: string;
    type?: string;
}

export interface DayClassification {
    day_type: string; // 'routine', 'travel', 'sick', 'social', 'rest', 'high_activity'
    notes?: string;
    confidence?: string;
}

/**
 * Unified Context Object passed to all agents.
 * This prevents "Context Fragmentation" by ensuring everyone sees the same world state.
 */
export interface PipelineContext {
    userId: string;
    sessionId: string;
    session?: any; // Full session object/history
    timezone: string;
    supabase: any; // SupabaseClient

    // User Data (Pre-fetched)
    userProfile?: UserProfile;
    userGoals?: UserGoal[];
    healthConstraints?: HealthConstraint[];
    memories?: Memory[];

    // Dynamic State
    dayClassification?: DayClassification;
    recentFoodLog?: any[]; // Last few items logged today
    trackedNutrients?: string[]; // Nutrients the user is tracking

    // Services (Optional, injected for convenience)
    db?: any; // DbService
}
