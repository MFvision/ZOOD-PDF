//! Extension methods for `Option` (clean-room implementation, MIT OR Apache-2.0).
#![no_std]

pub trait OptionExt<T> {
    /// `true` when the option is `Some(v)` and `x == v`.
    fn contains<U>(&self, x: &U) -> bool
    where
        U: PartialEq<T>;

    /// `Option::map_or` with the closure first.
    fn map_or2<U, F: FnOnce(T) -> U>(self, f: F, default: U) -> U;

    /// `Option::map_or_else` with the closure first.
    fn map_or_else2<U, F: FnOnce(T) -> U, D: FnOnce() -> U>(self, f: F, default: D) -> U;
}

impl<T> OptionExt<T> for Option<T> {
    fn contains<U>(&self, x: &U) -> bool
    where
        U: PartialEq<T>,
    {
        match self {
            Some(v) => x == v,
            None => false,
        }
    }

    fn map_or2<U, F: FnOnce(T) -> U>(self, f: F, default: U) -> U {
        match self {
            Some(v) => f(v),
            None => default,
        }
    }

    fn map_or_else2<U, F: FnOnce(T) -> U, D: FnOnce() -> U>(self, f: F, default: D) -> U {
        match self {
            Some(v) => f(v),
            None => default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OptionExt;

    #[test]
    fn behaves_like_option() {
        assert!(Some(3).contains(&3));
        assert!(!Some(3).contains(&4));
        assert!(!None::<i32>.contains(&3));
        assert_eq!(Some(2).map_or2(|v| v * 2, 0), 4);
        assert_eq!(None::<i32>.map_or2(|v| v * 2, 7), 7);
        assert_eq!(None::<i32>.map_or_else2(|v| v, || 9), 9);
    }
}
