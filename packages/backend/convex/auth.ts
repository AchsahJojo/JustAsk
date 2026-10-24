import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";

/** Caregiver accounts: email + password. Seniors never get a password; their extension holds a device token. */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        const email = String(params.email ?? "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ConvexError("Enter a valid email address.");
        const name = String(params.name ?? "").trim().slice(0, 60);
        const profile: { email: string; name?: string } = { email };
        if (name) profile.name = name;
        return profile as { email: string };
      },
      validatePasswordRequirements(password) {
        if (password.length < 8) throw new ConvexError("Use at least 8 characters for your password.");
      },
    }),
  ],
});
