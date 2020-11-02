import { GraphQLFloat, GraphQLString } from "graphql";
import { _testing } from "../src/GraphQLResource";
const { deflateParams, inflateParams } = _testing;

describe("Resource parameter deflation", () => {
    it("Deflates string", () => {
        const input = "a string";
        const deflated = deflateParams(input);
        expect(deflated).toEqual(input);
    });

    it("Deflates undefined", () => {
        const input = undefined;
        const deflated = deflateParams(input);
        expect(deflated).toEqual(input);
    });

    it("Deflates one level object", () => {
        const input = {
            a: 1,
            b: "bee"
        };
        const deflated = deflateParams(input);
        expect(deflated).toEqual(input);
    });

    it("Deflates deep object", () => {
        const input = {
            a: 1,
            b: "bee",
            c: {
                d: {
                    e: "eee"
                }
            }
        };
        const expected = {
            a: 1,
            b: "bee",
            "c.d.e": "eee"
        };
        const deflated = deflateParams(input);
        expect(deflated).toEqual(expected);
    });

    it("Deflates array field", () => {
        const input = {
            a: ["a", "b", "c"]
        };
        const expected = {
            "a.0": "a",
            "a.1": "b",
            "a.2": "c",
        };
        const deflated = deflateParams(input);
        expect(deflated).toEqual(expected);
    });

    it("Deflates reference object", () => {
        const input = {
            child: {
                ID: "i-d"
            },
        };
        const expected = {
            child: "i-d"
        };
        const deflated = deflateParams(input);
        expect(deflated).toEqual(expected);
    });

    it("Deflates array of reference objects", () => {
        const input = {
            child: [
                {
                    ID: "i-d-0"
                },
                {
                    ID: "i-d-1"
                },
            ]
        };
        const expected = {
            "child.0": "i-d-0",
            "child.1": "i-d-1",
        };
        const deflated = deflateParams(input, "ID");
        expect(deflated).toEqual(expected);
    });

    it("Keeps single-field objects", () => {
        const input = {
            child: {
                notID: "not ID"
            }
        };
        const expected = {
            "child.notID": "not ID"
        };
        const deflated = deflateParams(input, "ID");
        expect(deflated).toEqual(expected);
    });

});

describe("Resource parameter inflation", () => {
    it("Inflates one level object", () => {
        const input = {
            a: 1,
            b: "bee"
        };

        const inflated = inflateParams(input);
        expect(inflated).toEqual(input);
    });

    it("Inflates deep object", () => {
        const input = {
            a: 1,
            b: "bee",
            "c.d.e": "eee",
        };

        const expected = {
            a: 1,
            b: "bee",
            c: {
                d: {
                    e: "eee"
                }
            }
        };

        const inflated = inflateParams(input);
        expect(inflated).toEqual(expected);
    });

    it("Inflates nested array", () => {
        const input = {
            "array.0": "zero",
            "array.3": "three",
        };

        const expected = {
            array: [
                "zero",
                undefined,
                undefined,
                "three",
            ]
        };

        const inflated = inflateParams(input);
        expect(inflated).toEqual(expected);
    });
});

describe("Value conversion", () => {
    it("Converts string to float just fine", () => {
        const parsed = GraphQLFloat.serialize("42");
        expect(parsed).toEqual(42);
    });

    it("Converts a float to a string also", () => {
        const parsed = GraphQLString.serialize(42);
        expect(parsed).toEqual("42");
    });
});
