import Axios, { AxiosInstance } from "axios";
import { GraphQLFormattedError } from "graphql";
import {Agent as HTTPAgent, AgentOptions} from "http";
import {Agent as HTTPSAgent} from "https";

/**
 * A minimal GraphQL client.
 */
export class GraphQLClient {
    private readonly axios: AxiosInstance;

    constructor(endpoint: string, agentOptions: AgentOptions = {}) {
        const httpAgent = new HTTPAgent(agentOptions);
        const httpsAgent = new HTTPSAgent(agentOptions);

        this.axios = Axios.create({
            baseURL: endpoint,
            headers: {
                "content-type": "application/graphql+json",
            },
            httpAgent,
            httpsAgent,
        });
    }

    async request<T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
        headers?: Record<string, string>
    ): Promise<GraphQLClientResponse<T>> {
        const body = {
            query,
            variables
        };
        const response = await this.axios.post(
            "/",
            body,
            {
                headers
            }
            
        );
        return response.data;
    }
}

export interface GraphQLClientResponse<T> {
    data: T;
    errors: GraphQLFormattedError[];
}
