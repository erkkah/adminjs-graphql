import { BaseDatabase, BaseResource } from "adminjs";
import { GraphQLConnection } from "./index.js";
import {
    GraphQLResourceAdapter,
    InternalGraphQLResource,
} from "./GraphQLResource.js";

class GraphQLDatabaseAdapter extends BaseDatabase {
    public constructor(public readonly connection: GraphQLConnection) {
        super(connection);
    }

    public resources(): Array<BaseResource> {
        return this.connection.resources.map(
            (r) => new GraphQLResourceAdapter(r as InternalGraphQLResource)
        );
    }

    public static isAdapterFor(connection: GraphQLConnection): boolean {
        return connection.tag == "GraphQLConnection";
    }
}

export const GraphQLAdapter = {
    Database: GraphQLDatabaseAdapter,
    Resource: GraphQLResourceAdapter,
};
