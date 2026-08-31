import LoginForm from '@/components/Auth/LoginForm'

// The email-reset flow is gone with Supabase Auth, and with it the query-string
// outcomes this wrapper used to resolve — the form now stands on its own.
export default function LoginPage() {
    return <LoginForm />
}
