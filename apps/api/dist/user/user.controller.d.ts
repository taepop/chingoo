export declare class UserController {
    onboarding(body: any): Promise<{
        message: string;
    }>;
    getMe(query: any): Promise<{
        message: string;
    }>;
    updateTimezone(body: any): Promise<{
        message: string;
    }>;
    registerDevice(body: any): Promise<{
        message: string;
    }>;
    deleteMe(): Promise<{
        message: string;
    }>;
}
