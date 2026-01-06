/**
 * Tests for schema introspection
 */

import { describe, it, expect } from "vitest";
import { introspectSchema } from "../src/introspect.js";
import * as path from "path";

const FIXTURES_PATH = path.join(process.cwd(), "tests", "fixtures");

describe("introspectSchema", () => {
  it("should introspect a ZenStack schema file", async () => {
    const schema = await introspectSchema({
      schemaPath: path.join(FIXTURES_PATH, "schema.zmodel"),
    });

    expect(schema.models).toHaveLength(2);
    expect(schema.models.map((m) => m.name)).toContain("User");
    expect(schema.models.map((m) => m.name)).toContain("Post");
  });

  it("should extract User model fields correctly", async () => {
    const schema = await introspectSchema({
      schemaPath: path.join(FIXTURES_PATH, "schema.zmodel"),
    });

    const userModel = schema.models.find((m) => m.name === "User");
    expect(userModel).toBeDefined();

    const fields = userModel!.fields;
    const idField = fields.find((f) => f.name === "id");
    expect(idField).toMatchObject({
      name: "id",
      type: "Int",
      isId: true,
      hasDefault: true,
    });

    const emailField = fields.find((f) => f.name === "email");
    expect(emailField).toMatchObject({
      name: "email",
      type: "String",
      isUnique: true,
      isOptional: false,
    });

    const nameField = fields.find((f) => f.name === "name");
    expect(nameField).toMatchObject({
      name: "name",
      type: "String",
      isOptional: true,
    });
  });

  it("should detect relation fields", async () => {
    const schema = await introspectSchema({
      schemaPath: path.join(FIXTURES_PATH, "schema.zmodel"),
    });

    const userModel = schema.models.find((m) => m.name === "User");
    const postsField = userModel!.fields.find((f) => f.name === "posts");

    expect(postsField).toBeDefined();
    expect(postsField!.isArray).toBe(true);
  });

  it("should extract Post model with foreign key", async () => {
    const schema = await introspectSchema({
      schemaPath: path.join(FIXTURES_PATH, "schema.zmodel"),
    });

    const postModel = schema.models.find((m) => m.name === "Post");
    expect(postModel).toBeDefined();

    const authorIdField = postModel!.fields.find((f) => f.name === "authorId");
    expect(authorIdField).toMatchObject({
      name: "authorId",
      type: "Int",
    });
  });

  it("should throw error when no schema source provided", async () => {
    await expect(introspectSchema({})).rejects.toThrow(
      "Either schemaPath or databaseUrl must be provided"
    );
  });
});
