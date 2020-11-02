import Koa from "koa";
import gql from "graphql-tag";

import { LoggerPlugin, makeServerMiddleware } from "tiny-graphql-koa";

const app = new Koa();

interface Thing {
    ID?: string;
    name: string;
    another: Other[];
}

interface Other {
    ID?: string;
    name: string;
}

type FilterOperation = "EQ" | "LTE" | "GTE";

interface Filter {
    field: string;
    is: FilterOperation;
    than?: string;
    to?: string;
}

const others: Other[] = [
    {
        ID: "74",
        name: "Nail"
    },
    {
        ID: "91",
        name: "Tooth"
    }
];

const things: Thing[] = [
    {
        ID: "0",
        name: "Hammer",
        another: [others[0]]
    },
    {
        ID: "1",
        name: "Saw",
        another: others
    }
];

const graphqlServer = makeServerMiddleware({
    typedefs: [
        gql`
            type Thing {
                ID: ID!
                name: String!
                another: [Other!]!
            }

            type Other {
                ID: ID!
                name: String!
            }

            input ThingInput {
                name: String!
                anotherIDs: [ID!]!
            }

            enum FilterOperation {
                GTE
                LTE
                EQ
            }

            input FilterInput {
                field: String!
                is: FilterOperation!
                than: String
                to: String
            }

            type Query {
                things(filter: [FilterInput!], offset: Int! = 0, limit: Int! = 10): [Thing!]
                thing(ID: ID!): Thing
                thingCount(filter: [FilterInput!]): Int!

                others(filter: [FilterInput!], offset: Int! = 0, limit: Int! = 10): [Other!]
                other(ID: ID!): Other
                otherCount(filter: [FilterInput!]): Int!
            }

            type Mutation {
                createThing(input: ThingInput): Thing
                updateThing(ID: ID!, update: ThingInput!): Thing
                deleteThing(ID: ID!): Boolean!
            }
        `,
    ],
    resolvers: [
        {
            Query: {
                thing: (_parent, { ID }: { ID: string }) =>
                    things[+ID],
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                things: (_parent, _args: { filter: Filter }) => {
                    // Filtering is not implemented
                    return things;
                },
                thingCount: () => things.length,

                other: (_parent, { ID }: { ID: string }) =>
                    others.find((other) => other.ID === ID),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                others: (_parent, _args: { filter: Filter }) => {
                    // Filtering is not implemented
                    return others;
                },
                otherCount: () => others.length,
            },
            Mutation: {
                createThing: () => {
                    throw new Error("Not implemented");
                },
                updateThing: () => {
                    throw new Error("Not implemented");
                },
                deleteThing: () => {
                    throw new Error("Not implemented");
                },
            }
        }
    ],
    playgroundEndpoint: "/playground",
    plugins: [new LoggerPlugin()]
});

app.use(graphqlServer);
const server = app.listen(3000).on("listening", () => {
    console.log("Example server listening at:", server.address());
});
