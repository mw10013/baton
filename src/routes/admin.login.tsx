import type * as React from "react";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { AdminAuth } from "@/lib/AdminAuth";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { CurrentRequest } from "@/lib/CurrentRequest";
import { fieldError } from "@/lib/form";

const AdminLoginInput = Schema.Struct({
  password: Schema.String.check(
    Schema.isNonEmpty({ message: "Password is required" }),
  ),
});
type AdminLoginInput = typeof AdminLoginInput.Type;
type AdminLoginResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

const adminLoginFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(AdminLoginInput))
  .handler(({ data, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const env = yield* CloudflareEnv;
        const request = yield* CurrentRequest;
        const auth = yield* AdminAuth;
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = yield* Effect.promise(() =>
          env.ADMIN_LOGIN_LIMITER.limit({ key: `admin-login:${ip}` }),
        );
        if (!success)
          return {
            ok: false,
            error: "Too many attempts. Try again later.",
          } as const satisfies AdminLoginResult;
        const { ok } = yield* auth.attemptLogin(data.password);
        return (
          ok
            ? ({ ok: true } as const)
            : ({ ok: false, error: "Invalid password" } as const)
        ) satisfies AdminLoginResult;
      }),
    ),
  );

export const Route = createFileRoute("/admin/login")({
  head: () => ({
    meta: [{ name: "robots", content: "noindex,nofollow" }],
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  const adminLogin = useServerFn(adminLoginFn);

  const loginMutation = useMutation({
    mutationFn: (data: AdminLoginInput) => adminLogin({ data }),
    onSuccess: async (result) => {
      if (!result.ok) return;
      await navigate({ to: "/admin" });
    },
  });

  const form = useForm({
    defaultValues: { password: "" } satisfies AdminLoginInput,
    validators: { onSubmit: Schema.toStandardSchemaV1(AdminLoginInput) },
    onSubmit: ({ value }) => {
      void loginMutation.mutateAsync(value);
    },
  });

  return (
    <s-page>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <s-section heading="Admin login">
          {loginMutation.data && !loginMutation.data.ok && (
            <s-banner tone="critical">{loginMutation.data.error}</s-banner>
          )}
          <form.Field name="password">
            {(field) => (
              <s-password-field
                label="Password"
                name={field.name}
                value={field.state.value}
                error={fieldError(field.state.meta.errors)}
                onInput={(event) => {
                  field.handleChange(event.currentTarget.value);
                }}
                onBlur={field.handleBlur}
                {...{
                  onKeyDown: (event: React.KeyboardEvent) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void form.handleSubmit();
                    }
                  },
                }}
                required
              />
            )}
          </form.Field>
          <s-button
            type="submit"
            {...(loginMutation.isPending ? { loading: true } : {})}
          >
            Log in
          </s-button>
        </s-section>
      </form>
    </s-page>
  );
}
