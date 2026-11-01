package com.demo.owner;

import com.demo.model.Owner;
import java.util.Optional;

public interface OwnerRepository {
    Optional<Owner> findById(int id);

    Owner save(Owner owner);
}
