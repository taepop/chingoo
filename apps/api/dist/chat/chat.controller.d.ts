export declare class ChatController {
    sendMessage(body: any): Promise<{
        message: string;
    }>;
    getHistory(query: any): Promise<{
        message: string;
    }>;
}
