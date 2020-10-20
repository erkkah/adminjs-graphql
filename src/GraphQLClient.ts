import Axios, { AxiosInstance } from "axios";
import { GraphQLFormattedError } from "graphql";

/**
 * A minimal GraphQL client.
 */
export class GraphQLClient {
    private readonly axios: AxiosInstance;

    constructor(endpoint: string) {
        this.axios = Axios.create({
            baseURL: endpoint,
            headers: {
                "content-type": "application/graphql+json"
            }
        });
    }

    async request<T = Record<string, unknown>>(query: string, variables?: Record<string, unknown>): Promise<GraphQLClientResponse<T>> {
        const body = {
            query,
            variables
        };
        const response = await this.axios.post(
            "/",
            body
        );
        return response.data;
    }
}

export interface GraphQLClientResponse<T> {
    data: T;
    errors: GraphQLFormattedError[];
}
