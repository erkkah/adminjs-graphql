# admin-bro-graphql builder tools

Setting up a `GraphQLConnection` by implementing the different resources manually can be repetitive, especially for large APIs.

If the GraphQL API you want to connect to has a somewhat generic layout, I recommend that you create utilities for building the resources.

This directory contains one such utility toolset, which is based on a very specific GraphQL API layout.

If your API follows the exact same layout, this toolset will save you a lot of time. If not, you should be able to steal enough to build your own.

***Warning: There is quite a bit of magic involved to make this work. But it's fairly nice magic. :star:***

## Expected GraphQL API layout

This toolset basically expects a CRUD API. If you have a GraphQL Object called `Thing`, it expects the API to expose the following types, queries and mutations: 

```gql

type Thing {
    ID: ID!
    name: String!
    # ...
}

input ThingInput {
    name: String!
    # ...
}

enum FilterOperation {
    GTE
    LTE
    EQ
    MATCH
}

input FilterInput {
    field: String!
    is: FilterOperation!
    than: Scalar
    to: Scalar
}

enum SortOrder {
    ASC
    DESC
}

input SortingInput {
    by: String!
    order: SortOrder
}

type Query {
    things(filter: [FilterInput!], sorting: SortingInput, offset: Int! = 0, limit: Int! = 10): [Thing!]
    thing(ID: ID!): Thing
    thingCount(filter: [FilterInput!]): Int!
}

type Mutation {
    createThing(input: ThingInput): Thing
    updateThing(ID: ID!, update: ThingInput!): Thing
    deleteThing(ID: ID!): Boolean!
}

```

## Using the tools

See the examples directory and the [builder.ts](builder.ts) reference docs for example use of the tools.
